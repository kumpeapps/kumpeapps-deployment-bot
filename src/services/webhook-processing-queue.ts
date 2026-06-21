import type { FastifyBaseLogger } from "fastify";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";

type WebhookWorkItem = {
  deliveryId: string;
  eventName: string;
  payload: unknown;
  process: (input: { id: string; name: string; payload: unknown }) => Promise<void>;
};

const pending: WebhookWorkItem[] = [];
let activeCount = 0;
let logger: FastifyBaseLogger | null = null;

function logError(payload: Record<string, unknown>, message: string): void {
  if (logger) {
    logger.error(payload, message);
    return;
  }

  console.error(message, payload);
}

async function processItem(item: WebhookWorkItem): Promise<void> {
  try {
    await item.process({
      id: item.deliveryId,
      name: item.eventName,
      payload: item.payload
    });

    await prisma.githubWebhookDelivery.update({
      where: { deliveryId: item.deliveryId },
      data: {
        processStatus: "processed",
        processedAt: new Date(),
        errorMessage: null,
        lastAttemptAt: new Date()
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);

    await prisma.githubWebhookDelivery.update({
      where: { deliveryId: item.deliveryId },
      data: {
        processStatus: "failed",
        errorMessage: errorMessage.slice(0, 1000),
        lastAttemptAt: new Date()
      }
    }).catch((dbError: unknown) => {
      logError(
        { deliveryId: item.deliveryId, dbError },
        "Failed to mark webhook delivery as failed after processing error"
      );
    });

    logError(
      {
        deliveryId: item.deliveryId,
        eventName: item.eventName,
        errorMessage,
        errorType: error?.constructor?.name ?? typeof error
      },
      "Webhook background processing failed"
    );
  }
}

function drainQueue(): void {
  while (activeCount < appConfig.WEBHOOK_PROCESSING_CONCURRENCY && pending.length > 0) {
    const item = pending.shift();
    if (!item) {
      return;
    }

    activeCount += 1;
    void processItem(item)
      .catch((error: unknown) => {
        logError(
          { deliveryId: item.deliveryId, error },
          "Unexpected error escaping webhook background processor"
        );
      })
      .finally(() => {
        activeCount -= 1;
        drainQueue();
      });
  }
}

export function initWebhookProcessingQueue(log?: FastifyBaseLogger): void {
  logger = log ?? null;
}

export function enqueueWebhookProcessing(item: WebhookWorkItem): void {
  pending.push(item);
  drainQueue();
}

export function webhookProcessingQueueStats(): {
  pending: number;
  active: number;
  concurrency: number;
} {
  return {
    pending: pending.length,
    active: activeCount,
    concurrency: appConfig.WEBHOOK_PROCESSING_CONCURRENCY
  };
}
