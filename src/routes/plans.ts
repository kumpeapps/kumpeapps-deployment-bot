import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { authorizeAdminRequest } from "../services/admin-auth.js";
import { recordAuditEvent } from "../services/audit.js";

const UpsertPlanBodySchema = z.object({
  name: z.string().min(1).max(255),
  devPlanId: z.string().min(1).max(255).optional(),
  stagePlanId: z.string().min(1).max(255).optional(),
  prodPlanId: z.string().min(1).max(255).optional()
});

const AddUserPlanAuthorizationSchema = z.object({
  githubUsername: z.string().min(1).max(255),
  planName: z.string().min(1).max(255)
});

export async function registerPlanRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  // List all plans
  app.get("/api/admin/plans", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "plans.read"
      })
    ) {
      return;
    }

    const plans = await prisma.plan.findMany({
      orderBy: { name: "asc" }
    });

    return reply.send({
      count: plans.length,
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        devPlanId: p.devPlanId,
        stagePlanId: p.stagePlanId,
        prodPlanId: p.prodPlanId,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      }))
    });
  });

  // Get plan by name
  app.get<{ Params: { name: string } }>("/api/admin/plans/:name", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "plans.read"
      })
    ) {
      return;
    }

    const plan = await prisma.plan.findUnique({
      where: { name: request.params.name }
    });

    if (!plan) {
      return reply.code(404).send({ error: "Plan not found" });
    }

    return reply.send({
      id: plan.id,
      name: plan.name,
      devPlanId: plan.devPlanId,
      stagePlanId: plan.stagePlanId,
      prodPlanId: plan.prodPlanId,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt
    });
  });

  // Create or update a plan
  app.post("/api/admin/plans/upsert", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "plans.write"
      })
    ) {
      return;
    }

    const bodyParsed = UpsertPlanBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request", issues: bodyParsed.error.issues });
    }

    const { name, devPlanId, stagePlanId, prodPlanId } = bodyParsed.data;

    const plan = await prisma.plan.upsert({
      where: { name },
      update: {
        devPlanId,
        stagePlanId,
        prodPlanId
      },
      create: {
        name,
        devPlanId,
        stagePlanId,
        prodPlanId
      }
    });

    await recordAuditEvent({
      actorType: "admin",
      actorId: "admin_api",
      action: "plan.upserted",
      resourceType: "plan",
      resourceId: String(plan.id),
      payload: { name, devPlanId, stagePlanId, prodPlanId }
    });

    return reply.send({
      message: "Plan upserted successfully",
      plan: {
        id: plan.id,
        name: plan.name,
        devPlanId: plan.devPlanId,
        stagePlanId: plan.stagePlanId,
        prodPlanId: plan.prodPlanId
      }
    });
  });

  // Delete a plan
  app.delete<{ Params: { name: string } }>("/api/admin/plans/:name", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "plans.write"
      })
    ) {
      return;
    }

    const plan = await prisma.plan.findUnique({
      where: { name: request.params.name }
    });

    if (!plan) {
      return reply.code(404).send({ error: "Plan not found" });
    }

    await prisma.plan.delete({
      where: { name: request.params.name }
    });

    await recordAuditEvent({
      actorType: "admin",
      actorId: "admin_api",
      action: "plan.deleted",
      resourceType: "plan",
      resourceId: String(plan.id),
      payload: { name: plan.name }
    });

    return reply.send({ message: "Plan deleted successfully" });
  });

  // Get user's authorized plans
  app.get<{ Params: { username: string } }>("/api/admin/users/:username/plans", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "users.read"
      })
    ) {
      return;
    }

    const user = await prisma.user.findUnique({
      where: { githubUsername: request.params.username },
      include: { authorizedPlans: true }
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.send({
      githubUsername: user.githubUsername,
      authorizedPlans: user.authorizedPlans.map((ap) => ap.planName)
    });
  });

  // Add plan authorization for a user
  app.post("/api/admin/users/plans/authorize", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "users.write"
      })
    ) {
      return;
    }

    const bodyParsed = AddUserPlanAuthorizationSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request", issues: bodyParsed.error.issues });
    }

    const { githubUsername, planName } = bodyParsed.data;

    const user = await prisma.user.findUnique({
      where: { githubUsername }
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    const plan = await prisma.plan.findUnique({
      where: { name: planName }
    });

    if (!plan) {
      return reply.code(404).send({ error: "Plan not found" });
    }

    await prisma.authorizedPlan.upsert({
      where: {
        userId_planName: {
          userId: user.id,
          planName
        }
      },
      update: {},
      create: {
        userId: user.id,
        planName
      }
    });

    await recordAuditEvent({
      actorType: "admin",
      actorId: "admin_api",
      action: "user.plan_authorized",
      resourceType: "user",
      resourceId: String(user.id),
      payload: { githubUsername, planName }
    });

    return reply.send({
      message: "Plan authorization added successfully",
      githubUsername,
      planName
    });
  });

  // Remove plan authorization from a user
  app.post("/api/admin/users/plans/revoke", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "users.write"
      })
    ) {
      return;
    }

    const bodyParsed = AddUserPlanAuthorizationSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request", issues: bodyParsed.error.issues });
    }

    const { githubUsername, planName } = bodyParsed.data;

    const user = await prisma.user.findUnique({
      where: { githubUsername }
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    await prisma.authorizedPlan.deleteMany({
      where: {
        userId: user.id,
        planName
      }
    });

    await recordAuditEvent({
      actorType: "admin",
      actorId: "admin_api",
      action: "user.plan_revoked",
      resourceType: "user",
      resourceId: String(user.id),
      payload: { githubUsername, planName }
    });

    return reply.send({
      message: "Plan authorization revoked successfully",
      githubUsername,
      planName
    });
  });
}
