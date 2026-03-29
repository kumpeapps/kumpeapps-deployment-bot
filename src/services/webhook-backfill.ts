/**
 * GitHub Webhook Backfill Service
 * 
 * Queries GitHub's App webhook delivery API to find webhooks that failed to reach
 * the bot (e.g., during downtime) and replays them.
 * 
 * This is different from webhook-retry-scheduler which only retries webhooks that
 * were received but failed to process.
 */

import { appConfig } from "../config.js";
import { prisma } from "../db.js";
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "fs";
import type { FastifyBaseLogger } from "fastify";

/**
 * GitHub App webhook delivery response types
 */
type GitHubWebhookDelivery = {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  duration: number;
  status: string; // "OK", "Invalid HTTP Response: 500", etc.
  status_code: number;
  event: string;
  action: string | null;
  installation_id: number | null;
  repository_id: number | null;
};

type GitHubWebhookDeliveryDetail = GitHubWebhookDelivery & {
  request: {
    headers: Record<string, string>;
    payload: any;
  };
  response: {
    headers: Record<string, string>;
    payload: any;
  };
};

/**
 * Get GitHub App private key
 */
function getPrivateKey(): string | null {
  if (appConfig.GITHUB_APP_PRIVATE_KEY.trim()) {
    return appConfig.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  }

  if (appConfig.GITHUB_APP_PRIVATE_KEY_PATH.trim()) {
    try {
      return readFileSync(appConfig.GITHUB_APP_PRIVATE_KEY_PATH, "utf-8");
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Check if webhook backfill is configured
 */
export function isWebhookBackfillConfigured(): boolean {
  if (!appConfig.GITHUB_APP_ID || !appConfig.WEBHOOK_RETRY_ENABLED) {
    return false;
  }

  const privateKey = getPrivateKey();
  return privateKey !== null && privateKey.length > 0;
}

/**
 * Get a GitHub App JWT token for API calls
 */
async function getAppToken(): Promise<string | null> {
  try {
    const privateKey = getPrivateKey();
    if (!privateKey) {
      return null;
    }

    const auth = createAppAuth({
      appId: appConfig.GITHUB_APP_ID!,
      privateKey: privateKey
    });

    const { token } = await auth({ type: "app" });
    return token;
  } catch (error) {
    console.error("Failed to generate GitHub App token:", error);
    return null;
  }
}

/**
 * Fetch recent webhook deliveries from GitHub
 */
async function fetchRecentDeliveries(
  token: string,
  perPage: number = 100
): Promise<GitHubWebhookDelivery[]> {
  const url = `https://api.github.com/app/hook/deliveries?per_page=${perPage}`;
  
  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch webhook deliveries: HTTP ${response.status}`);
  }

  return (await response.json()) as GitHubWebhookDelivery[];
}

/**
 * Fetch full webhook delivery details including payload
 */
async function fetchDeliveryDetail(
  token: string,
  deliveryId: number
): Promise<GitHubWebhookDeliveryDetail | null> {
  const url = `https://api.github.com/app/hook/deliveries/${deliveryId}`;
  
  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as GitHubWebhookDeliveryDetail;
}

/**
 * Process a failed webhook delivery by replaying it
 */
async function replayWebhookDelivery(
  delivery: GitHubWebhookDeliveryDetail,
  processWebhook: (payload: { id: string; name: string; payload: any }) => Promise<void>,
  logger: FastifyBaseLogger
): Promise<boolean> {
  const deliveryGuid = delivery.guid;

  // Check if we already processed this delivery
  const existing = await prisma.githubWebhookDelivery.findUnique({
    where: { deliveryId: deliveryGuid }
  });

  if (existing?.processStatus === "processed") {
    logger.debug(
      { deliveryId: deliveryGuid, event: delivery.event },
      "Skipping already processed webhook"
    );
    return false;
  }

  // Create or update delivery record
  if (!existing) {
    await prisma.githubWebhookDelivery.create({
      data: {
        deliveryId: deliveryGuid,
        eventName: delivery.event,
        processStatus: "in_progress"
      }
    });
  } else {
    await prisma.githubWebhookDelivery.update({
      where: { id: existing.id },
      data: {
        processStatus: "in_progress",
        attemptsCount: { increment: 1 },
        lastAttemptAt: new Date()
      }
    });
  }

  // Process the webhook
  try {
    await processWebhook({
      id: deliveryGuid,
      name: delivery.event,
      payload: delivery.request.payload
    });

    await prisma.githubWebhookDelivery.update({
      where: { deliveryId: deliveryGuid },
      data: {
        processStatus: "processed",
        processedAt: new Date(),
        errorMessage: null,
        lastAttemptAt: new Date()
      }
    });

    logger.info(
      { deliveryId: deliveryGuid, event: delivery.event },
      "Successfully replayed missed webhook"
    );
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error 
      ? `${error.message}\n${error.stack ?? ""}` 
      : String(error);

    await prisma.githubWebhookDelivery.update({
      where: { deliveryId: deliveryGuid },
      data: {
        processStatus: "failed",
        errorMessage: errorMessage.slice(0, 1000),
        lastAttemptAt: new Date()
      }
    });

    logger.error(
      { deliveryId: deliveryGuid, event: delivery.event, error: errorMessage },
      "Failed to replay missed webhook"
    );
    return false;
  }
}

/**
 * Backfill missed webhook deliveries from GitHub
 * 
 * Queries GitHub's webhook delivery API to find webhooks that failed to reach
 * the bot and replays them.
 */
export async function backfillMissedWebhooks(
  processWebhook: (payload: { id: string; name: string; payload: any }) => Promise<void>,
  logger: FastifyBaseLogger
): Promise<{ processed: number; failed: number; skipped: number }> {
  if (!isWebhookBackfillConfigured()) {
    logger.debug("Webhook backfill not configured or disabled");
    return { processed: 0, failed: 0, skipped: 0 };
  }

  try {
    const token = await getAppToken();
    if (!token) {
      logger.error("Failed to get GitHub App token for webhook backfill");
      return { processed: 0, failed: 0, skipped: 0 };
    }

    // Fetch recent deliveries from GitHub
    const recentDeliveries = await fetchRecentDeliveries(token);
    
    // Filter for failed deliveries (non-2xx status codes)
    const failedDeliveries = recentDeliveries.filter(d => {
      // Only process deliveries from the last WEBHOOK_RETRY_MAX_AGE_DAYS
      const deliveredAt = new Date(d.delivered_at);
      const maxAge = appConfig.WEBHOOK_RETRY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      const tooOld = Date.now() - deliveredAt.getTime() > maxAge;
      
      // Consider failed if status code is not 2xx
      const isFailed = d.status_code < 200 || d.status_code >= 300;
      
      return !tooOld && isFailed;
    });

    if (failedDeliveries.length === 0) {
      logger.info("No missed webhooks found to backfill");
      return { processed: 0, failed: 0, skipped: 0 };
    }

    logger.info(
      { count: failedDeliveries.length },
      "Found missed webhooks to backfill"
    );

    let processed = 0;
    let failed = 0;
    let skipped = 0;

    // Process each failed delivery
    for (const delivery of failedDeliveries) {
      // Fetch full delivery details including payload
      const detail = await fetchDeliveryDetail(token, delivery.id);
      if (!detail) {
        logger.warn(
          { deliveryId: delivery.guid },
          "Failed to fetch delivery details, skipping"
        );
        skipped += 1;
        continue;
      }

      const success = await replayWebhookDelivery(detail, processWebhook, logger);
      if (success) {
        processed += 1;
      } else if (!success) {
        // Check if it was skipped (already processed) or failed
        const record = await prisma.githubWebhookDelivery.findUnique({
          where: { deliveryId: delivery.guid }
        });
        if (record?.processStatus === "processed") {
          skipped += 1;
        } else {
          failed += 1;
        }
      }

      // Rate limit: small delay between replays
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info(
      { processed, failed, skipped },
      "Webhook backfill completed"
    );

    return { processed, failed, skipped };
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Error during webhook backfill"
    );
    return { processed: 0, failed: 0, skipped: 0 };
  }
}
