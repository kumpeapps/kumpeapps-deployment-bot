import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authorizeAdminRequest } from "../services/admin-auth.js";
import { recordAuditEvent } from "../services/audit.js";
import { syncRepositoryDeploymentConfigs } from "../services/github-config-sync.js";

const SyncBodySchema = z.object({
  ref: z.string().min(1).max(120).default("main")
});

const ParamsSchema = z.object({
  repositoryOwner: z.string().min(1).max(255),
  repositoryName: z.string().min(1).max(255)
});

export async function registerRepositoryConfigRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  app.post("/api/admin/repositories/:repositoryOwner/:repositoryName/sync-configs", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "repositoryConfigs.sync"
    });
    if (!principal) {
      return;
    }

    const paramsParsed = ParamsSchema.safeParse(request.params);
    const bodyParsed = SyncBodySchema.safeParse(request.body ?? {});

    if (!paramsParsed.success || !bodyParsed.success) {
      return reply.code(400).send({
        error: "Invalid request",
        paramsIssues: paramsParsed.success ? [] : paramsParsed.error.issues,
        bodyIssues: bodyParsed.success ? [] : bodyParsed.error.issues
      });
    }

    try {
      const result = await syncRepositoryDeploymentConfigs({
        repositoryOwner: paramsParsed.data.repositoryOwner,
        repositoryName: paramsParsed.data.repositoryName,
        ref: bodyParsed.data.ref
      });

      await recordAuditEvent({
        actorType: "admin",
        actorId: principal.actorId,
        action: "repository.configs.synced",
        resourceType: "repository",
        resourceId: `${paramsParsed.data.repositoryOwner}/${paramsParsed.data.repositoryName}`,
        payload: {
          ref: bodyParsed.data.ref,
          synced: result.synced,
          skipped: result.skipped,
          errors: result.errors.length
        }
      });

      return reply.send({
        repositoryOwner: paramsParsed.data.repositoryOwner,
        repositoryName: paramsParsed.data.repositoryName,
        ref: bodyParsed.data.ref,
        ...result
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Sync failed"
      });
    }
  });
}
