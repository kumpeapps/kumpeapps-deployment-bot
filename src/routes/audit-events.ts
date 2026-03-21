import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { authorizeAdminRequest } from "../services/admin-auth.js";

const QuerySchema = z.object({
  action: z.string().min(1).max(120).optional(),
  resourceType: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50)
});

export async function registerAuditEventRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  app.get("/api/admin/audit-events", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "audit.read"
      })
    ) {
      return;
    }

    const queryParsed = QuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    const events = await prisma.auditEvent.findMany({
      where: {
        action: queryParsed.data.action,
        resourceType: queryParsed.data.resourceType
      },
      orderBy: { createdAt: "desc" },
      take: queryParsed.data.limit
    });

    return reply.send({
      count: events.length,
      events
    });
  });
}
