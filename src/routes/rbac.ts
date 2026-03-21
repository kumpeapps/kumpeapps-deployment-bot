import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authorizeAdminRequest,
  deactivateAdminRoleBindingByHash,
  listAdminRoleBindings,
  upsertAdminRoleBinding
} from "../services/admin-auth.js";
import { recordAuditEvent } from "../services/audit.js";

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50)
});

const UpsertBodySchema = z.object({
  token: z.string().min(16),
  role: z.enum(["owner", "operator", "auditor"]),
  description: z.string().min(1).max(500).optional()
});

const DeactivateBodySchema = z.object({
  tokenHash: z.string().length(64)
});

export async function registerRbacRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  app.get("/api/admin/rbac/role-bindings", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "rbac.manage"
      })
    ) {
      return;
    }

    const queryParsed = ListQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    const rows = await listAdminRoleBindings(queryParsed.data.limit);
    return reply.send({
      count: rows.length,
      bindings: rows.map((row) => ({
        id: row.id,
        tokenHash: row.tokenHash,
        role: row.role,
        source: row.source,
        active: row.active,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString()
      }))
    });
  });

  app.post("/api/admin/rbac/role-bindings/upsert", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "rbac.manage"
    });
    if (!principal) {
      return;
    }

    const bodyParsed = UpsertBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: bodyParsed.error.issues });
    }

    await upsertAdminRoleBinding({
      token: bodyParsed.data.token,
      role: bodyParsed.data.role,
      description: bodyParsed.data.description,
      source: "manual"
    });

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "rbac.role_binding.upserted",
      resourceType: "admin_role_binding",
      resourceId: bodyParsed.data.role,
      payload: {
        role: bodyParsed.data.role,
        description: bodyParsed.data.description ?? null,
        tokenLength: bodyParsed.data.token.length
      }
    });

    return reply.code(202).send({
      updated: true,
      role: bodyParsed.data.role
    });
  });

  app.post("/api/admin/rbac/role-bindings/deactivate", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "rbac.manage"
    });
    if (!principal) {
      return;
    }

    const bodyParsed = DeactivateBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: bodyParsed.error.issues });
    }

    const affected = await deactivateAdminRoleBindingByHash(bodyParsed.data.tokenHash);

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "rbac.role_binding.deactivated",
      resourceType: "admin_role_binding",
      resourceId: bodyParsed.data.tokenHash,
      payload: {
        affected
      }
    });

    return reply.code(202).send({
      deactivated: affected
    });
  });
}
