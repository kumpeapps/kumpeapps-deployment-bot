import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export async function recordAuditEvent(input: {
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      payloadJson: input.payload as Prisma.InputJsonValue | undefined
    }
  });
}
