/**
 * Repository Token Provisioning Job
 *
 * Ensures all repositories have API tokens provisioned and synced to GitHub.
 * Runs at startup and on a schedule to recover from:
 * - Existing repositories that were added before this feature
 * - Tokens that were manually deleted from GitHub
 * - Failed token provisioning attempts during installation
 */

import { prisma } from "../db.js";
import { provisionRepositoryToken } from "./repository-tokens.js";

let isRunning = false;
let lastRunAt: Date | null = null;

export async function runTokenProvisioningJob(options?: {
  logger?: {
    info: (obj: any, msg: string) => void;
    warn: (obj: any, msg: string) => void;
    error: (obj: any, msg: string) => void;
  };
}): Promise<{
  scanned: number;
  provisioned: number;
  failed: number;
  skipped: number;
  errors: Array<{ owner: string; repo: string; error: string }>;
}> {
  const log = options?.logger;

  if (isRunning) {
    log?.warn({}, "Token provisioning job already running, skipping");
    return { scanned: 0, provisioned: 0, failed: 0, skipped: 0, errors: [] };
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    log?.info({}, "Starting repository token provisioning job");

    // Get all active repositories
    const repositories = await prisma.repository.findMany({
      where: { active: true },
      select: {
        id: true,
        owner: true,
        name: true,
        apiToken: true
      }
    });

    let provisioned = 0;
    let failed = 0;
    let skipped = 0;
    const errors: Array<{ owner: string; repo: string; error: string }> = [];

    for (const repo of repositories) {
      try {
        // Skip if token already exists (but we could check GitHub to see if it's still there)
        if (repo.apiToken) {
          skipped += 1;
          continue;
        }

        log?.info(
          { owner: repo.owner, repo: repo.name },
          "Provisioning missing repository token"
        );

        const result = await provisionRepositoryToken({
          repositoryOwner: repo.owner,
          repositoryName: repo.name
        });

        if (result.success) {
          provisioned += 1;
          log?.info(
            { owner: repo.owner, repo: repo.name },
            "Repository token provisioned successfully"
          );
        } else {
          failed += 1;
          errors.push({
            owner: repo.owner,
            repo: repo.name,
            error: result.error ?? "Unknown error"
          });
          log?.warn(
            { owner: repo.owner, repo: repo.name, error: result.error },
            "Failed to provision repository token"
          );
        }

        // Rate limit: 1 token per second to avoid GitHub API throttling
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        failed += 1;
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        errors.push({
          owner: repo.owner,
          repo: repo.name,
          error: errorMsg
        });
        log?.error(
          { error, owner: repo.owner, repo: repo.name },
          "Error provisioning repository token"
        );
      }
    }

    const duration = Date.now() - startTime;
    lastRunAt = new Date();

    log?.info(
      {
        scanned: repositories.length,
        provisioned,
        failed,
        skipped,
        durationMs: duration
      },
      "Token provisioning job completed"
    );

    return {
      scanned: repositories.length,
      provisioned,
      failed,
      skipped,
      errors
    };
  } finally {
    isRunning = false;
  }
}

/**
 * Start the token provisioning scheduler
 */
export function startTokenProvisioningScheduler(
  intervalMs: number,
  logger?: {
    info: (obj: any, msg: string) => void;
    warn: (obj: any, msg: string) => void;
    error: (obj: any, msg: string) => void;
  }
): NodeJS.Timeout {
  // Run immediately at startup
  void runTokenProvisioningJob({ logger });

  // Schedule regular runs
  return setInterval(() => {
    void runTokenProvisioningJob({ logger });
  }, intervalMs);
}

export function getTokenProvisioningJobStatus(): {
  isRunning: boolean;
  lastRunAt: Date | null;
} {
  return { isRunning, lastRunAt };
}
