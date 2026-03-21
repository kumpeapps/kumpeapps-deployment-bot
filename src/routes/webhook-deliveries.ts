import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { authorizeAdminRequest } from "../services/admin-auth.js";

const QuerySchema = z.object({
  status: z.enum(["in_progress", "processed", "failed"]).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50)
});

const ParamsSchema = z.object({
  deliveryId: z.string().min(1).max(120)
});

export async function registerWebhookDeliveryRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  app.get("/api/admin/webhook-deliveries", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "webhookDeliveries.read"
      })
    ) {
      return;
    }

    const queryParsed = QuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    const rows = await prisma.githubWebhookDelivery.findMany({
      where: {
        processStatus: queryParsed.data.status
      },
      orderBy: { lastAttemptAt: "desc" },
      take: queryParsed.data.limit
    });

    return reply.send({
      count: rows.length,
      deliveries: rows
    });
  });

  app.get("/api/admin/webhook-deliveries/:deliveryId", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "webhookDeliveries.read"
      })
    ) {
      return;
    }

    const paramsParsed = ParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid params", issues: paramsParsed.error.issues });
    }

    const row = await prisma.githubWebhookDelivery.findUnique({
      where: { deliveryId: paramsParsed.data.deliveryId }
    });

    if (!row) {
      return reply.code(404).send({ error: "Webhook delivery not found" });
    }

    return reply.send({ delivery: row });
  });
}
