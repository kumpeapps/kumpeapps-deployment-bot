import { prisma } from "../db.js";
import { appConfig } from "../config.js";
import type { FastifyBaseLogger } from "fastify";
import { backfillMissedWebhooks } from "./webhook-backfill.js";
import { getWebhookProcessor } from "../routes/webhooks.js";

let retryIntervalHandle: NodeJS.Timeout | null = null;

/**
 * Process failed webhooks and retry them
 * Called periodically to retry webhooks that failed during outages or temporary issues
 */
async function processFailedWebhooks(logger: FastifyBaseLogger): Promise<void> {
  if (!appConfig.WEBHOOK_RETRY_ENABLED) {
    return;
  }

  try {
    const now = new Date();
    const retryThreshold = new Date(now.getTime() - appConfig.WEBHOOK_RETRY_INTERVAL_MS);
    const maxAgeThreshold = new Date(now.getTime() - (appConfig.WEBHOOK_RETRY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000));

    // Find failed webhooks that are eligible for retry
    // Don't retry webhooks older than WEBHOOK_RETRY_MAX_AGE_DAYS (they likely need manual intervention)
    const failedWebhooks = await prisma.githubWebhookDelivery.findMany({
      where: {
        processStatus: "failed",
        attemptsCount: { lt: appConfig.WEBHOOK_RETRY_MAX_ATTEMPTS },
        lastAttemptAt: { lt: retryThreshold },
        receivedAt: { gte: maxAgeThreshold }
      },
      orderBy: { lastAttemptAt: "asc" },
      take: 100 // Process in batches to avoid overwhelming the system
    });

    if (failedWebhooks.length === 0) {
      return;
    }

    logger.info(
      { 
        count: failedWebhooks.length,
        maxAttempts: appConfig.WEBHOOK_RETRY_MAX_ATTEMPTS,
        intervalMs: appConfig.WEBHOOK_RETRY_INTERVAL_MS
      },
      "Found failed webhooks eligible for retry"
    );

    for (const webhook of failedWebhooks) {
      logger.info(
        {
          deliveryId: webhook.deliveryId,
          eventName: webhook.eventName,
          attemptsCount: webhook.attemptsCount,
          lastAttemptAt: webhook.lastAttemptAt.toISOString(),
          errorMessage: webhook.errorMessage?.substring(0, 200)
        },
        "Webhook retry attempted but webhook reprocessing not yet implemented"
      );

      // TODO: Implement actual webhook reprocessing
      // This would require:
      // 1. Storing the original webhook payload in the database
      // 2. Re-invoking the webhook handler with the stored payload
      // 3. Updating the delivery record based on the result
      //
      // For now, we just log that retries are attempted but not processed
      // The webhook will remain in "failed" state until manually redelivered by GitHub
      // or until it's pruned after WEBHOOK_DELIVERY_RETENTION_DAYS
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Error processing failed webhooks for retry"
    );
  }
}

/**
 * Start the webhook retry scheduler
 * Runs periodically to retry failed webhooks that occurred during outages
 */
export function startWebhookRetryScheduler(
  intervalMs: number,
  logger: FastifyBaseLogger
): void {
  if (!appConfig.WEBHOOK_RETRY_ENABLED) {
    logger.info("Webhook retry scheduler disabled by configuration");
    return;
  }

  if (retryIntervalHandle !== null) {
    logger.warn("Webhook retry scheduler already running");
    return;
  }

  logger.info(
    { 
      intervalMs,
      maxAttempts: appConfig.WEBHOOK_RETRY_MAX_ATTEMPTS,
      retryIntervalMs: appConfig.WEBHOOK_RETRY_INTERVAL_MS,
      maxAgeDays: appConfig.WEBHOOK_RETRY_MAX_AGE_DAYS
    },
    "Starting webhook retry scheduler"
  );

  // Run immediately on startup to catch any failed webhooks from previous outage
  processFailedWebhooks(logger).catch((error) => {
    logger.error({ error }, "Failed to process webhooks on scheduler startup");
  });
  
  // Backfill missed webhooks from GitHub (webhooks that never reached the bot)
  const webhookProcessor = getWebhookProcessor();
  if (webhookProcessor) {
    backfillMissedWebhooks(webhookProcessor, logger).catch((error) => {
      logger.error({ error }, "Failed to backfill missed webhooks on scheduler startup");
    });
  }

  // Then run periodically
  retryIntervalHandle = setInterval(() => {
    processFailedWebhooks(logger).catch((error) => {
      logger.error({ error }, "Failed to process webhooks in scheduled run");
    });
    
    // Also check for missed webhooks periodically
    const processor = getWebhookProcessor();
    if (processor) {
      backfillMissedWebhooks(processor, logger).catch((error) => {
        logger.error({ error }, "Failed to backfill missed webhooks in scheduled run");
      });
    }
  }, intervalMs);
}

/**
 * Stop the webhook retry scheduler (for graceful shutdown)
 */
export function stopWebhookRetryScheduler(logger: FastifyBaseLogger): void {
  if (retryIntervalHandle !== null) {
    clearInterval(retryIntervalHandle);
    retryIntervalHandle = null;
    logger.info("Webhook retry scheduler stopped");
  }
}
