import { prisma } from "../db.js";
import { appConfig } from "../config.js";

export async function pruneOldWebhookDeliveries(): Promise<{
  deletedCount: number;
  cutoffDate: Date;
}> {
  const retentionDays = appConfig.WEBHOOK_DELIVERY_RETENTION_DAYS;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  cutoffDate.setHours(0, 0, 0, 0);

  const result = await prisma.githubWebhookDelivery.deleteMany({
    where: {
      OR: [
        {
          processStatus: "processed",
          processedAt: { lt: cutoffDate }
        },
        {
          processStatus: "failed",
          lastAttemptAt: { lt: cutoffDate }
        }
      ]
    }
  });

  return {
    deletedCount: result.count,
    cutoffDate
  };
}
