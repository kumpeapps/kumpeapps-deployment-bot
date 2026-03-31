import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";
import { authorizeAdminRequest } from "../services/admin-auth.js";
import { recordAuditEvent } from "../services/audit.js";
import { requeueDeploymentJob, deploymentQueueDetailedStats } from "../services/deployment-queue.js";
import { pruneExpiredSnoozesRecords } from "../services/alert-snooze-cleanup.js";
import { pruneOldDeploymentJobs } from "../services/deployment-job-cleanup.js";
import {
  buildDeploymentStatusView,
  buildStepsHtml,
  buildDeploymentStatusHtml,
  buildNotFoundHtml
} from "../services/deployment-status-view.js";

const DeploymentListQuerySchema = z.object({
  repositoryOwner: z.string().min(1).max(255),
  repositoryName: z.string().min(1).max(255),
  limit: z.coerce.number().int().positive().max(100).default(20)
});

const DeploymentDetailParamsSchema = z.object({
  id: z.coerce.number().int().positive()
});

const DeploymentJobsQuerySchema = z.object({
  status: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50)
});

const AdminRecentDeploymentsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20)
});

const DeploymentJobRequeueBodySchema = z.object({
  reason: z.string().min(1).max(500).describe("Reason for requeuing the job")
});

const QueueAlertSnoozeBodySchema = z.object({
  reason: z.string().min(1).max(500),
  minutes: z.coerce.number().int().positive()
});

const QueueAlertUnsnoozeBodySchema = z.object({
  reason: z.string().min(1).max(500).optional()
});

const QueueAlertSnoozesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20)
});

export async function registerDeploymentQueryRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  app.get("/api/deployments", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "deployments.read"
      })
    ) {
      return;
    }

    const queryParsed = DeploymentListQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    const repository = await prisma.repository.findUnique({
      where: {
        owner_name: {
          owner: queryParsed.data.repositoryOwner,
          name: queryParsed.data.repositoryName
        }
      }
    });

    if (!repository) {
      return reply.code(404).send({ error: "Repository not found in control plane" });
    }

    const deployments = await prisma.deployment.findMany({
      where: { repositoryId: repository.id },
      orderBy: { startedAt: "desc" },
      take: queryParsed.data.limit,
      include: {
        steps: {
          orderBy: { startedAt: "asc" }
        }
      }
    });

    return reply.send({
      repositoryOwner: queryParsed.data.repositoryOwner,
      repositoryName: queryParsed.data.repositoryName,
      count: deployments.length,
      deployments
    });
  });

  // Public endpoint for viewing deployment status (no auth required)
  // Used as target URL for GitHub commit status checks
  app.get("/deployments/:id/status", async (request, reply) => {
    const paramsParsed = DeploymentDetailParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid deployment ID" });
    }

    const deployment = await prisma.deployment.findUnique({
      where: { id: paramsParsed.data.id },
      include: {
        repository: true,
        steps: {
          orderBy: { startedAt: "asc" }
        }
      }
    });

    if (!deployment) {
      return reply.code(404).type("text/html; charset=utf-8").send(
        buildNotFoundHtml(paramsParsed.data.id)
      );
    }

    const { storyboardImage, status } = buildDeploymentStatusView(deployment);
    const stepsHtml = buildStepsHtml(deployment.steps);
    const html = buildDeploymentStatusHtml({
      deployment,
      storyboardImage,
      status,
      stepsHtml
    });

    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/api/deployments/:id", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "deployments.read"
      })
    ) {
      return;
    }

    const paramsParsed = DeploymentDetailParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid params", issues: paramsParsed.error.issues });
    }

    const deployment = await prisma.deployment.findUnique({
      where: { id: paramsParsed.data.id },
      include: {
        repository: true,
        steps: {
          orderBy: { startedAt: "asc" }
        },
        caddyReleases: true,
        secretsResolutionAudit: true
      }
    });

    if (!deployment) {
      return reply.code(404).send({ error: "Deployment not found" });
    }

    return reply.send({ deployment });
  });

  app.get("/api/deployment-jobs", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "deployments.read"
      })
    ) {
      return;
    }

    const queryParsed = DeploymentJobsQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    const jobs = await prisma.deploymentJob.findMany({
      where: {
        status: queryParsed.data.status
      },
      orderBy: { createdAt: "desc" },
      take: queryParsed.data.limit
    });

    return reply.send({
      count: jobs.length,
      jobs
    });
  });

  app.get("/api/deployment-jobs/:id", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "deployments.read"
      })
    ) {
      return;
    }

    const paramsParsed = DeploymentDetailParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid params", issues: paramsParsed.error.issues });
    }

    const job = await prisma.deploymentJob.findUnique({
      where: { id: paramsParsed.data.id }
    });

    if (!job) {
      return reply.code(404).send({ error: "Deployment job not found" });
    }

    return reply.send({ job });
  });

  app.get("/api/admin/deployments/recent", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "deployments.read"
      })
    ) {
      return;
    }

    const queryParsed = AdminRecentDeploymentsQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    const deployments = await prisma.deployment.findMany({
      orderBy: { startedAt: "desc" },
      take: queryParsed.data.limit,
      select: {
        id: true,
        environment: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        repository: {
          select: {
            owner: true,
            name: true
          }
        }
      }
    });

    return reply.send({
      count: deployments.length,
      deployments
    });
  });

  app.post("/api/deployment-jobs/:id/requeue", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "jobs.requeue"
    });
    if (!principal) {
      return;
    }

    const paramsParsed = DeploymentDetailParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid params", issues: paramsParsed.error.issues });
    }

    const bodyParsed = DeploymentJobRequeueBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: bodyParsed.error.issues });
    }

    try {
      const result = await requeueDeploymentJob(paramsParsed.data.id);

      if (!result) {
        return reply.code(404).send({ error: "Deployment job not found" });
      }

      await recordAuditEvent({
        actorType: "admin",
        actorId: principal.actorId,
        action: "requeue_deployment_job",
        resourceType: "deployment_job",
        resourceId: String(paramsParsed.data.id),
        payload: {
          previousStatus: result.previousStatus,
          reason: bodyParsed.data.reason
        }
      });

      const updatedJob = await prisma.deploymentJob.findUnique({
        where: { id: paramsParsed.data.id }
      });

      return reply.code(202).send({
        message: "Job requeued successfully",
        job: updatedJob
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error during requeue";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/api/admin/queue-stats", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "queue.read"
      })
    ) {
      return;
    }

    const stats = await deploymentQueueDetailedStats();
    return reply.send(stats);
  });

  app.get("/api/admin/queue-alerts", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "queue.read"
      })
    ) {
      return;
    }

    const queryParsed = QueueAlertSnoozesQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    const now = new Date();
    const activeSnooze = await prisma.queueAlertSnooze.findFirst({
      where: {
        startsAt: { lte: now },
        endsAt: { gt: now }
      },
      orderBy: { endsAt: "desc" }
    });

    const recentSnoozes = await prisma.queueAlertSnooze.findMany({
      orderBy: { createdAt: "desc" },
      take: queryParsed.data.limit
    });

    return reply.send({
      active: activeSnooze
        ? {
            id: activeSnooze.id,
            reason: activeSnooze.reason,
            startsAt: activeSnooze.startsAt.toISOString(),
            endsAt: activeSnooze.endsAt.toISOString(),
            actorType: activeSnooze.actorType,
            actorId: activeSnooze.actorId,
            remainingMinutes: Math.max(0, Math.ceil((activeSnooze.endsAt.getTime() - now.getTime()) / (60 * 1000)))
          }
        : null,
      recent: recentSnoozes.map(
        (item: {
          id: number;
          reason: string;
          startsAt: Date;
          endsAt: Date;
          actorType: string;
          actorId: string;
        }) => ({
          id: item.id,
          reason: item.reason,
          startsAt: item.startsAt.toISOString(),
          endsAt: item.endsAt.toISOString(),
          actorType: item.actorType,
          actorId: item.actorId,
          isActive: item.startsAt <= now && item.endsAt > now
        })
      )
    });
  });

  app.post("/api/admin/queue-alerts/snooze", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "queue.manage"
    });
    if (!principal) {
      return;
    }

    const bodyParsed = QueueAlertSnoozeBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: bodyParsed.error.issues });
    }

    if (bodyParsed.data.minutes > appConfig.DEPLOY_QUEUE_ALERT_MAX_SNOOZE_MINUTES) {
      return reply.code(400).send({
        error: `minutes exceeds max configured snooze window (${appConfig.DEPLOY_QUEUE_ALERT_MAX_SNOOZE_MINUTES})`
      });
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + bodyParsed.data.minutes * 60 * 1000);

    const snooze = await prisma.queueAlertSnooze.create({
      data: {
        reason: bodyParsed.data.reason,
        startsAt: now,
        endsAt,
        actorType: "admin",
        actorId: principal.actorId
      }
    });

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "snooze_queue_alerts",
      resourceType: "queue_alerts",
      resourceId: "global",
      payload: {
        reason: bodyParsed.data.reason,
        minutes: bodyParsed.data.minutes,
        endsAt: endsAt.toISOString(),
        snoozeId: snooze.id
      }
    });

    const stats = await deploymentQueueDetailedStats();
    return reply.code(202).send({
      message: "Queue alerts snoozed",
      snooze: {
        id: snooze.id,
        reason: snooze.reason,
        endsAt: snooze.endsAt.toISOString()
      },
      alerts: stats.alerts,
      alertSuppression: stats.alertSuppression
    });
  });

  app.post("/api/admin/queue-alerts/unsnooze", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "queue.manage"
    });
    if (!principal) {
      return;
    }

    const bodyParsed = QueueAlertUnsnoozeBodySchema.safeParse(request.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: bodyParsed.error.issues });
    }

    const now = new Date();
    const result = await prisma.queueAlertSnooze.updateMany({
      where: {
        startsAt: { lte: now },
        endsAt: { gt: now }
      },
      data: {
        endsAt: now
      }
    });

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "unsnooze_queue_alerts",
      resourceType: "queue_alerts",
      resourceId: "global",
      payload: {
        reason: bodyParsed.data.reason ?? null,
        affectedSnoozes: result.count
      }
    });

    const stats = await deploymentQueueDetailedStats();
    return reply.code(202).send({
      message: "Queue alert snooze cleared",
      affectedSnoozes: result.count,
      alerts: stats.alerts,
      alertSuppression: stats.alertSuppression
    });
  });

  app.post("/api/admin/queue-alerts/cleanup", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "queue.manage"
    });
    if (!principal) {
      return;
    }

    try {
      const result = await pruneExpiredSnoozesRecords();

      await recordAuditEvent({
        actorType: "admin",
        actorId: principal.actorId,
        action: "cleanup_snooze_records",
        resourceType: "queue_alert_snoozes",
        resourceId: "global",
        payload: {
          deletedCount: result.deletedCount,
          cutoffDate: result.cutoffDate.toISOString()
        }
      });

      return reply.code(200).send({
        message: "Snooze records cleaned up",
        deletedCount: result.deletedCount,
        cutoffDate: result.cutoffDate.toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error during cleanup";
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/admin/deployment-jobs/cleanup", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "jobs.cleanup"
    });
    if (!principal) {
      return;
    }

    try {
      const result = await pruneOldDeploymentJobs();

      await recordAuditEvent({
        actorType: "admin",
        actorId: principal.actorId,
        action: "cleanup_deployment_jobs",
        resourceType: "deployment_jobs",
        resourceId: "global",
        payload: {
          deletedCount: result.deletedCount,
          cutoffDate: result.cutoffDate.toISOString()
        }
      });

      return reply.code(200).send({
        message: "Deployment jobs cleaned up",
        deletedCount: result.deletedCount,
        cutoffDate: result.cutoffDate.toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error during cleanup";
      return reply.code(500).send({ error: message });
    }
  });
}
