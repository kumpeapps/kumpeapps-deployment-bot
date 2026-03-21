import { prisma } from "../db.js";
import { appConfig } from "../config.js";

/**
 * Prunes expired QueueAlertSnooze records based on DEPLOY_QUEUE_ALERT_SNOOZE_RETENTION_DAYS config
 */
export async function pruneExpiredSnoozesRecords(): Promise<{
  deletedCount: number;
  cutoffDate: Date;
}> {
  try {
    const retentionDays = appConfig.DEPLOY_QUEUE_ALERT_SNOOZE_RETENTION_DAYS;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    cutoffDate.setHours(0, 0, 0, 0);

    const result = await prisma.queueAlertSnooze.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate,
        },
      },
    });

    return {
      deletedCount: result.count,
      cutoffDate,
    };
  } catch (error) {
    throw error;
  }
}
