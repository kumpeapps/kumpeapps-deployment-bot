import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { authorizeAdminRequest } from "../services/admin-auth.js";
import {
  decryptSecretValue,
  decryptSecretValueWithPassphrase,
  encryptSecretValue,
  encryptSecretValueWithPassphrase,
  isEncryptedSecretValue
} from "../services/secret-crypto.js";
import { recordSecretDecryptFailure } from "../services/secret-health.js";
import { pruneOldWebhookDeliveries } from "../services/webhook-delivery-cleanup.js";
import { recordAuditEvent } from "../services/audit.js";

const RotateSecretsBodySchema = z.object({
  oldPassphrase: z.string().min(16).optional(),
  newPassphrase: z.string().min(16).optional(),
  dryRun: z.boolean().default(true)
});

export async function registerOperationsRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  app.post("/api/admin/operations/rotate-secret-encryption", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "operations.rotateSecrets"
    });
    if (!principal) {
      return;
    }

    const bodyParsed = RotateSecretsBodySchema.safeParse(request.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request", issues: bodyParsed.error.issues });
    }

    const secrets = await prisma.repositorySecret.findMany();
    let reencryptedCount = 0;
    let skippedCount = 0;

    for (const secret of secrets) {
      let plaintext: string;
      try {
        if (bodyParsed.data.oldPassphrase) {
          plaintext = decryptSecretValueWithPassphrase(secret.value, bodyParsed.data.oldPassphrase);
        } else {
          plaintext = decryptSecretValue(secret.value);
        }
      } catch (error) {
        recordSecretDecryptFailure({
          repositoryId: secret.repositoryId,
          secretName: secret.name,
          reason: error instanceof Error ? error.message : "unknown decrypt error"
        });
        app.log.warn({ error, secretId: secret.id }, "Skipping secret that could not be decrypted");
        skippedCount += 1;
        continue;
      }

      const nextCiphertext = bodyParsed.data.newPassphrase
        ? encryptSecretValueWithPassphrase(plaintext, bodyParsed.data.newPassphrase)
        : encryptSecretValue(plaintext);

      if (bodyParsed.data.dryRun) {
        if (nextCiphertext !== secret.value || !isEncryptedSecretValue(secret.value)) {
          reencryptedCount += 1;
        }
        continue;
      }

      await prisma.repositorySecret.update({
        where: { id: secret.id },
        data: { value: nextCiphertext }
      });
      reencryptedCount += 1;
    }

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "operations.rotate_secret_encryption",
      resourceType: "repository_secret",
      resourceId: "global",
      payload: {
        dryRun: bodyParsed.data.dryRun,
        totalSecrets: secrets.length,
        reencryptedCount,
        skippedCount,
        usedOldPassphrase: Boolean(bodyParsed.data.oldPassphrase),
        usedNewPassphrase: Boolean(bodyParsed.data.newPassphrase)
      }
    });

    return reply.send({
      dryRun: bodyParsed.data.dryRun,
      totalSecrets: secrets.length,
      reencryptedCount,
      skippedCount
    });
  });

  app.post("/api/admin/operations/cleanup-webhook-deliveries", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "operations.cleanupWebhookDeliveries"
    });
    if (!principal) {
      return;
    }

    try {
      const result = await pruneOldWebhookDeliveries();

      await recordAuditEvent({
        actorType: "admin",
        actorId: principal.actorId,
        action: "operations.cleanup_webhook_deliveries",
        resourceType: "github_webhook_delivery",
        resourceId: "global",
        payload: {
          deletedCount: result.deletedCount,
          cutoffDate: result.cutoffDate.toISOString()
        }
      });

      return reply.send({
        message: "Webhook delivery records cleaned up",
        deletedCount: result.deletedCount,
        cutoffDate: result.cutoffDate.toISOString()
      });
    } catch (error) {
      return reply.code(500).send({
        error: error instanceof Error ? error.message : "Webhook delivery cleanup failed"
      });
    }
  });
}
