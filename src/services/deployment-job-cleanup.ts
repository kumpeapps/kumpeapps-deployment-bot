import { prisma } from "../db.js";
import { appConfig } from "../config.js";

/**
 * Prunes old DeploymentJob records (succeeded/failed) based on DEPLOY_QUEUE_JOB_RETENTION_DAYS config
 */
export async function pruneOldDeploymentJobs(): Promise<{
  deletedCount: number;
  cutoffDate: Date;
}> {
  try {
    const retentionDays = appConfig.DEPLOY_QUEUE_JOB_RETENTION_DAYS;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    cutoffDate.setHours(0, 0, 0, 0);

    const result = await prisma.deploymentJob.deleteMany({
      where: {
        status: { in: ["succeeded", "failed"] },
        finishedAt: {
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
