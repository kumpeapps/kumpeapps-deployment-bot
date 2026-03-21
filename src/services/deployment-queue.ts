import type { FastifyBaseLogger } from "fastify";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";
import { executeDeployment, type ExecuteDeploymentInput, VmApprovalPendingError } from "./deployment-runner.js";

type DeploymentJobPayload = Omit<ExecuteDeploymentInput, "dryRunOnlyGuard">;

let pollTimer: NodeJS.Timeout | null = null;
let runningCount = 0;
let fastifyLogger: FastifyBaseLogger | null = null;

function logError(payload: Record<string, unknown>, message: string): void {
  if (!fastifyLogger) {
    console.error(message, payload);
    return;
  }

  fastifyLogger.error(payload, message);
}

function nowMinusLease(): Date {
  return new Date(Date.now() - appConfig.DEPLOY_QUEUE_RUNNING_LEASE_MS);
}

async function requeueExpiredRunningJobs(): Promise<void> {
  await prisma.deploymentJob.updateMany({
    where: {
      status: "running",
      startedAt: { lt: nowMinusLease() }
    },
    data: {
      status: "queued",
      errorMessage: "Recovered stale running job after lease timeout",
      startedAt: null,
      leaseReclaimCount: { increment: 1 }
    }
  });
}

async function claimNextJob(): Promise<{
  id: number;
  payloadJson: unknown;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
} | null> {
  const candidate = await prisma.deploymentJob.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      payloadJson: true,
      attempts: true,
      maxAttempts: true,
      timeoutMs: true
    }
  });

  if (!candidate) {
    return null;
  }

  console.log(`[Deployment Queue] Found queued job ${candidate.id}, attempting to claim...`);

  const claimed = await prisma.deploymentJob.updateMany({
    where: {
      id: candidate.id,
      status: "queued"
    },
    data: {
      status: "running",
      attempts: { increment: 1 },
      startedAt: new Date(),
      errorMessage: null
    }
  });

  if (claimed.count === 0) {
    return null;
  }

  return candidate;
}

async function runClaimedJob(job: {
  id: number;
  payloadJson: unknown;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
}): Promise<void> {
  console.log(`[Deployment Queue] Executing job ${job.id} (attempt ${job.attempts + 1}/${job.maxAttempts})`);
  const payload = job.payloadJson as DeploymentJobPayload;
  const timeoutMs = job.timeoutMs > 0 ? job.timeoutMs : appConfig.DEPLOY_QUEUE_JOB_TIMEOUT_MS;

  const executeWithTimeout = async (): Promise<{ deploymentId: number }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Deployment job timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      void executeDeployment({
        ...payload,
        dryRunOnlyGuard: appConfig.DEPLOY_EXECUTION_DRY_RUN_ONLY
      })
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });

  try {
    const result = await executeWithTimeout();

    console.log(`[Deployment Queue] Job ${job.id} completed successfully, deployment ID: ${result.deploymentId}`);
    await prisma.deploymentJob.update({
      where: { id: job.id },
      data: {
        status: "succeeded",
        deploymentId: result.deploymentId,
        finishedAt: new Date(),
        errorMessage: null
      }
    });
  } catch (error) {
    console.log(`[Deployment Queue] Job ${job.id} failed with error:`, error);
    const message = error instanceof Error ? error.message : "unknown queue execution error";
    const isTimeoutError = message.includes("timed out after");
    const nextStatus = job.attempts + 1 >= job.maxAttempts ? "failed" : "queued";

    // Special handling for VM approval pending - not a real error
    if (error instanceof VmApprovalPendingError) {
      await prisma.deploymentJob.update({
        where: { id: job.id },
        data: {
          status: "pending_approval",
          errorMessage: message,
          finishedAt: null,
          startedAt: null
        }
      });

      if (fastifyLogger) {
        fastifyLogger.info(
          {
            jobId: job.id,
            nextStatus: "pending_approval",
            message
          },
          "Deployment waiting for VM approval"
        );
      } else {
        console.log(`[Deployment Queue] Job ${job.id} waiting for VM approval: ${message}`);
      }
      
      return;
    }

    // Regular error handling
    await prisma.deploymentJob.update({
      where: { id: job.id },
      data: {
        status: nextStatus,
        errorMessage: message,
        finishedAt: nextStatus === "failed" ? new Date() : null,
        startedAt: null,
        timeoutFailuresCount: isTimeoutError ? { increment: 1 } : undefined
      }
    });

    logError(
      {
        jobId: job.id,
        nextStatus,
        errorMessage: message,
        errorStack: error instanceof Error ? error.stack : undefined
      },
      "Deployment queue job execution failed"
    );
  }
}

async function drainOnce(): Promise<void> {
  while (runningCount < appConfig.DEPLOY_QUEUE_CONCURRENCY) {
    const claimed = await claimNextJob();
    if (!claimed) {
      return;
    }

    runningCount += 1;

    void runClaimedJob(claimed).finally(() => {
      runningCount -= 1;
    });
  }
}

async function poll(): Promise<void> {
  try {
    await requeueExpiredRunningJobs();
    await drainOnce();
  } catch (error) {
    logError({ error }, "Deployment queue poll failed");
  }
}

export async function triggerQueuePoll(): Promise<void> {
  await poll();
}

export async function enqueueDeploymentJob(input: {
  label: string;
  payload: DeploymentJobPayload;
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<{ jobId: number }> {
  const job = await prisma.deploymentJob.create({
    data: {
      label: input.label,
      payloadJson: input.payload,
      status: "queued",
      maxAttempts: input.maxAttempts ?? 3,
      timeoutMs: input.timeoutMs ?? appConfig.DEPLOY_QUEUE_JOB_TIMEOUT_MS
    },
    select: { id: true }
  });

  void poll();

  return { jobId: job.id };
}

export async function deploymentQueueDetailedStats(): Promise<{
  current: {
    queued: number;
    running: number;
    failed: number;
    succeeded: number;
    activeWorkers: number;
    concurrency: number;
  };
  recentActivity: {
    period: "last_hour" | "last_day";
    succeeded: number;
    failed: number;
    avgDurationMs: number | null;
    avgAttempts: number | null;
    successRate: number;
  };
  jobRetryInsights: {
    totalRetries: number;
    jobsExhaustedRetries: number;
    avgRetriesPerFailed: number;
  };
  failurePatterns: {
    leaseReclaims24h: number;
    userRequeues24h: number;
    timeoutFailures24h: number;
  };
  timeoutInsights: {
    defaultTimeoutMs: number;
    avgQueuedTimeoutMs: number | null;
    avgRunningTimeoutMs: number | null;
    minConfiguredTimeoutMs: number | null;
    maxConfiguredTimeoutMs: number | null;
    timedOutLast24h: number;
  };
  alerts: {
    queueDepthHigh: boolean;
    successRateLow: boolean;
    timeoutFailuresHigh: boolean;
    leaseReclaimsHigh: boolean;
    userRequeuesHigh: boolean;
    requiresAttention: boolean;
    requiresAttentionEffective: boolean;
    thresholds: {
      queueDepthHigh: number;
      successRateMinPercent: number;
      timeoutFailures24hHigh: number;
      leaseReclaims24hHigh: number;
      userRequeues24hHigh: number;
    };
  };
  alertSuppression: {
    isSnoozed: boolean;
    snoozedUntil: string | null;
    reason: string | null;
    remainingMinutes: number | null;
  };
  health: {
    queueDepth: number;
    isHealthy: boolean;
    estimatedMinutesToClear: number | null;
  };
}> {
  const grouped = await prisma.deploymentJob.groupBy({
    by: ["status"],
    _count: { _all: true }
  });

  const counts = new Map<string, number>(
    grouped.map((item: { status: string; _count: { _all: number } }) => [item.status, item._count._all])
  );

  const current = {
    queued: counts.get("queued") ?? 0,
    running: counts.get("running") ?? 0,
    failed: counts.get("failed") ?? 0,
    succeeded: counts.get("succeeded") ?? 0,
    activeWorkers: runningCount,
    concurrency: appConfig.DEPLOY_QUEUE_CONCURRENCY
  };

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const lastHourJobs = await prisma.deploymentJob.findMany({
    where: {
      finishedAt: { gte: oneHourAgo },
      status: { in: ["succeeded", "failed"] }
    },
    select: {
      status: true,
      attempts: true,
      finishedAt: true,
      startedAt: true
    }
  });

  const lastDayJobs = await prisma.deploymentJob.findMany({
    where: {
      finishedAt: { gte: oneDayAgo },
      status: { in: ["succeeded", "failed"] }
    },
    select: {
      status: true,
      attempts: true,
      finishedAt: true,
      startedAt: true
    }
  });

  const calcStats = (
    jobs: Array<{ status: string; attempts: number; finishedAt: Date | null; startedAt: Date | null }>
  ) => {
    const succeededCount = jobs.filter((j) => j.status === "succeeded").length;
    const failedCount = jobs.filter((j) => j.status === "failed").length;
    const total = succeededCount + failedCount;

    const durations = jobs
      .filter((j) => j.startedAt && j.finishedAt)
      .map((j) => j.finishedAt!.getTime() - j.startedAt!.getTime());

    const avgDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    const avgAttempts = total > 0 ? jobs.reduce((sum, j) => sum + j.attempts, 0) / total : null;

    return {
      succeeded: succeededCount,
      failed: failedCount,
      avgDurationMs,
      avgAttempts,
      successRate: total > 0 ? (succeededCount / total) * 100 : 0
    };
  };

  const recentActivityHour = calcStats(lastHourJobs);
  const recentActivityDay = calcStats(lastDayJobs);

  const failedJobs = await prisma.deploymentJob.findMany({
    where: { status: "failed" },
    select: { attempts: true, maxAttempts: true }
  });

  const timeoutGrouped = await prisma.deploymentJob.groupBy({
    by: ["status"],
    _avg: { timeoutMs: true },
    where: {
      status: { in: ["queued", "running"] }
    }
  });

  const timeoutExtrema = await prisma.deploymentJob.aggregate({
    _min: { timeoutMs: true },
    _max: { timeoutMs: true }
  });

  const timedOutLast24h = await prisma.deploymentJob.count({
    where: {
      status: "failed",
      finishedAt: { gte: oneDayAgo },
      errorMessage: { contains: "timed out after" }
    }
  });

  // Aggregate failure reason counters from last 24h jobs
  const failureCountersLast24h = await prisma.deploymentJob.aggregate({
    _sum: {
      leaseReclaimCount: true,
      requeueCount: true,
      timeoutFailuresCount: true
    },
    where: {
      finishedAt: { gte: oneDayAgo }
    }
  });

  const totalRetries = failedJobs.reduce(
    (sum: number, j: { attempts: number; maxAttempts: number }) => sum + (j.attempts - 1),
    0
  );
  const jobsExhausted = failedJobs.filter(
    (j: { attempts: number; maxAttempts: number }) => j.attempts >= j.maxAttempts
  ).length;
  const avgRetriesPerFailed = failedJobs.length > 0 ? totalRetries / failedJobs.length : 0;

  const queueDepth = current.queued + current.running;
  const isHealthy = current.failed < current.succeeded || current.failed < 10;
  const estimatedMinutesToClear =
    current.queued > 0 && appConfig.DEPLOY_QUEUE_CONCURRENCY > 0 && recentActivityDay.avgDurationMs
      ? Math.ceil((current.queued * recentActivityDay.avgDurationMs) / (appConfig.DEPLOY_QUEUE_CONCURRENCY * 60 * 1000))
      : null;

  const queuedTimeout = timeoutGrouped.find((item: { status: string }) => item.status === "queued");
  const runningTimeout = timeoutGrouped.find((item: { status: string }) => item.status === "running");
  const leaseReclaims24h = failureCountersLast24h._sum.leaseReclaimCount ?? 0;
  const userRequeues24h = failureCountersLast24h._sum.requeueCount ?? 0;
  const timeoutFailures24h = failureCountersLast24h._sum.timeoutFailuresCount ?? 0;
  const queueDepthHigh = queueDepth >= appConfig.DEPLOY_QUEUE_ALERT_QUEUE_DEPTH_HIGH;
  const successRateLow = recentActivityHour.successRate < appConfig.DEPLOY_QUEUE_ALERT_SUCCESS_RATE_MIN_PERCENT;
  const timeoutFailuresHigh = timedOutLast24h >= appConfig.DEPLOY_QUEUE_ALERT_TIMEOUT_FAILURES_24H_HIGH;
  const leaseReclaimsHigh = leaseReclaims24h >= appConfig.DEPLOY_QUEUE_ALERT_LEASE_RECLAIMS_24H_HIGH;
  const userRequeuesHigh = userRequeues24h >= appConfig.DEPLOY_QUEUE_ALERT_USER_REQUEUES_24H_HIGH;
  const requiresAttention =
    queueDepthHigh || successRateLow || timeoutFailuresHigh || leaseReclaimsHigh || userRequeuesHigh;
  const now = new Date();
  const activeSnooze = await prisma.queueAlertSnooze.findFirst({
    where: {
      startsAt: { lte: now },
      endsAt: { gt: now }
    },
    orderBy: { endsAt: "desc" }
  });
  const isSnoozed = Boolean(activeSnooze);
  const requiresAttentionEffective = requiresAttention && !isSnoozed;
  const remainingMinutes = activeSnooze
    ? Math.max(0, Math.ceil((activeSnooze.endsAt.getTime() - now.getTime()) / (60 * 1000)))
    : null;

  return {
    current,
    recentActivity: {
      period: "last_hour",
      ...recentActivityHour
    },
    jobRetryInsights: {
      totalRetries,
      jobsExhaustedRetries: jobsExhausted,
      avgRetriesPerFailed: Number(avgRetriesPerFailed.toFixed(2))
    },
    failurePatterns: {
      leaseReclaims24h,
      userRequeues24h,
      timeoutFailures24h
    },
    timeoutInsights: {
      defaultTimeoutMs: appConfig.DEPLOY_QUEUE_JOB_TIMEOUT_MS,
      avgQueuedTimeoutMs: queuedTimeout?._avg.timeoutMs ?? null,
      avgRunningTimeoutMs: runningTimeout?._avg.timeoutMs ?? null,
      minConfiguredTimeoutMs: timeoutExtrema._min.timeoutMs ?? null,
      maxConfiguredTimeoutMs: timeoutExtrema._max.timeoutMs ?? null,
      timedOutLast24h
    },
    alerts: {
      queueDepthHigh,
      successRateLow,
      timeoutFailuresHigh,
      leaseReclaimsHigh,
      userRequeuesHigh,
      requiresAttention,
      requiresAttentionEffective,
      thresholds: {
        queueDepthHigh: appConfig.DEPLOY_QUEUE_ALERT_QUEUE_DEPTH_HIGH,
        successRateMinPercent: appConfig.DEPLOY_QUEUE_ALERT_SUCCESS_RATE_MIN_PERCENT,
        timeoutFailures24hHigh: appConfig.DEPLOY_QUEUE_ALERT_TIMEOUT_FAILURES_24H_HIGH,
        leaseReclaims24hHigh: appConfig.DEPLOY_QUEUE_ALERT_LEASE_RECLAIMS_24H_HIGH,
        userRequeues24hHigh: appConfig.DEPLOY_QUEUE_ALERT_USER_REQUEUES_24H_HIGH
      }
    },
    alertSuppression: {
      isSnoozed,
      snoozedUntil: activeSnooze?.endsAt.toISOString() ?? null,
      reason: activeSnooze?.reason ?? null,
      remainingMinutes
    },
    health: {
      queueDepth,
      isHealthy,
      estimatedMinutesToClear
    }
  };
}

export async function deploymentQueueStats(): Promise<{
  queued: number;
  running: number;
  failed: number;
  succeeded: number;
  activeWorkers: number;
  concurrency: number;
}> {
  const detailed = await deploymentQueueDetailedStats();
  return detailed.current;
}

export async function deploymentQueuePrometheusMetrics(): Promise<string> {
  const stats = await deploymentQueueDetailedStats();
  const c = stats.current;
  const r = stats.recentActivity;
  const h = stats.health;
  const t = stats.timeoutInsights;
  const a = stats.alerts;
  const s = stats.alertSuppression;
  const f = stats.failurePatterns;

  const lines: string[] = [
    "# HELP deployment_queue_jobs_queued Number of queued deployment jobs",
    "# TYPE deployment_queue_jobs_queued gauge",
    `deployment_queue_jobs_queued ${c.queued}`,
    "",
    "# HELP deployment_queue_jobs_running Number of running deployment jobs",
    "# TYPE deployment_queue_jobs_running gauge",
    `deployment_queue_jobs_running ${c.running}`,
    "",
    "# HELP deployment_queue_jobs_succeeded Total succeeded deployment jobs",
    "# TYPE deployment_queue_jobs_succeeded counter",
    `deployment_queue_jobs_succeeded ${c.succeeded}`,
    "",
    "# HELP deployment_queue_jobs_failed Total failed deployment jobs",
    "# TYPE deployment_queue_jobs_failed counter",
    `deployment_queue_jobs_failed ${c.failed}`,
    "",
    "# HELP deployment_queue_active_workers Number of active worker processes",
    "# TYPE deployment_queue_active_workers gauge",
    `deployment_queue_active_workers ${c.activeWorkers}`,
    "",
    "# HELP deployment_queue_concurrency Configured max concurrency for queue workers",
    "# TYPE deployment_queue_concurrency gauge",
    `deployment_queue_concurrency ${c.concurrency}`,
    "",
    "# HELP deployment_queue_depth_total Current queue depth (queued + running jobs)",
    "# TYPE deployment_queue_depth_total gauge",
    `deployment_queue_depth_total ${h.queueDepth}`,
    "",
    "# HELP deployment_queue_success_rate_1hour Success rate over last hour as percentage",
    "# TYPE deployment_queue_success_rate_1hour gauge",
    `deployment_queue_success_rate_1hour ${r.successRate}`,
    "",
    "# HELP deployment_queue_avg_duration_ms Average job duration in milliseconds (last hour)",
    "# TYPE deployment_queue_avg_duration_ms gauge",
    `deployment_queue_avg_duration_ms ${r.avgDurationMs ?? 0}`,
    "",
    "# HELP deployment_queue_retry_exhausted Number of jobs that exceeded max retry attempts",
    "# TYPE deployment_queue_retry_exhausted gauge",
    `deployment_queue_retry_exhausted ${stats.jobRetryInsights.jobsExhaustedRetries}`,
    "",
    "# HELP deployment_queue_lease_reclaims_24h Stale running jobs recovered via lease timeout (24h)",
    "# TYPE deployment_queue_lease_reclaims_24h counter",
    `deployment_queue_lease_reclaims_24h ${f.leaseReclaims24h}`,
    "",
    "# HELP deployment_queue_user_requeues_24h User-initiated job requeues (24h)",
    "# TYPE deployment_queue_user_requeues_24h counter",
    `deployment_queue_user_requeues_24h ${f.userRequeues24h}`,
    "",
    "# HELP deployment_queue_timeout_failures_24h Jobs that failed due to timeout (24h)",
    "# TYPE deployment_queue_timeout_failures_24h counter",
    `deployment_queue_timeout_failures_24h ${f.timeoutFailures24h}`,
    "",
    "# HELP deployment_queue_timeout_default_ms Default per-job timeout in milliseconds",
    "# TYPE deployment_queue_timeout_default_ms gauge",
    `deployment_queue_timeout_default_ms ${t.defaultTimeoutMs}`,
    "",
    "# HELP deployment_queue_timeout_avg_running_ms Average timeout value for running jobs",
    "# TYPE deployment_queue_timeout_avg_running_ms gauge",
    `deployment_queue_timeout_avg_running_ms ${t.avgRunningTimeoutMs ?? 0}`,
    "",
    "# HELP deployment_queue_timeout_failures_24h_count Failed jobs due to timeout during last 24 hours",
    "# TYPE deployment_queue_timeout_failures_24h_count counter",
    `deployment_queue_timeout_failures_24h_count ${t.timedOutLast24h}`,
    "",
    "# HELP deployment_queue_alert_queue_depth_high_flag Alert flag for queue depth high threshold",
    "# TYPE deployment_queue_alert_queue_depth_high_flag gauge",
    `deployment_queue_alert_queue_depth_high_flag ${a.queueDepthHigh ? 1 : 0}`,
    "",
    "# HELP deployment_queue_alert_success_rate_low_flag Alert flag for low recent success rate",
    "# TYPE deployment_queue_alert_success_rate_low_flag gauge",
    `deployment_queue_alert_success_rate_low_flag ${a.successRateLow ? 1 : 0}`,
    "",
    "# HELP deployment_queue_alert_timeout_failures_high_flag Alert flag for high timeout failures in 24h",
    "# TYPE deployment_queue_alert_timeout_failures_high_flag gauge",
    `deployment_queue_alert_timeout_failures_high_flag ${a.timeoutFailuresHigh ? 1 : 0}`,
    "",
    "# HELP deployment_queue_alert_lease_reclaims_high_flag Alert flag for high stale-running-job reclaims in 24h",
    "# TYPE deployment_queue_alert_lease_reclaims_high_flag gauge",
    `deployment_queue_alert_lease_reclaims_high_flag ${a.leaseReclaimsHigh ? 1 : 0}`,
    "",
    "# HELP deployment_queue_alert_user_requeues_high_flag Alert flag for high manual requeues in 24h",
    "# TYPE deployment_queue_alert_user_requeues_high_flag gauge",
    `deployment_queue_alert_user_requeues_high_flag ${a.userRequeuesHigh ? 1 : 0}`,
    "",
    "# HELP deployment_queue_alert_requires_attention_flag Aggregated alert flag for queue attention",
    "# TYPE deployment_queue_alert_requires_attention_flag gauge",
    `deployment_queue_alert_requires_attention_flag ${a.requiresAttention ? 1 : 0}`,
    "",
    "# HELP deployment_queue_alert_requires_attention_effective_flag Aggregated alert flag after snooze suppression",
    "# TYPE deployment_queue_alert_requires_attention_effective_flag gauge",
    `deployment_queue_alert_requires_attention_effective_flag ${a.requiresAttentionEffective ? 1 : 0}`,
    "",
    "# HELP deployment_queue_alert_snoozed_flag Queue alert snooze active flag",
    "# TYPE deployment_queue_alert_snoozed_flag gauge",
    `deployment_queue_alert_snoozed_flag ${s.isSnoozed ? 1 : 0}`,
    "",
    "# HELP deployment_queue_alert_snooze_remaining_minutes Remaining minutes in active alert snooze",
    "# TYPE deployment_queue_alert_snooze_remaining_minutes gauge",
    `deployment_queue_alert_snooze_remaining_minutes ${s.remainingMinutes ?? 0}`,
    "",
    "# HELP deployment_queue_health_flag Health check flag (1=healthy, 0=unhealthy)",
    "# TYPE deployment_queue_health_flag gauge",
    `deployment_queue_health_flag ${h.isHealthy ? 1 : 0}`,
    ""
  ];

  return lines.join("\n");
}

export async function requeueDeploymentJob(jobId: number): Promise<{
  jobId: number;
  previousStatus: string;
} | null> {
  const job = await prisma.deploymentJob.findUnique({
    where: { id: jobId },
    select: {
      status: true,
      attempts: true,
      maxAttempts: true
    }
  });

  if (!job) {
    return null;
  }

  if (job.status !== "failed") {
    throw new Error(`Cannot requeue job in status '${job.status}' (only 'failed' jobs can be requeued)`);
  }

  await prisma.deploymentJob.update({
    where: { id: jobId },
    data: {
      status: "queued",
      errorMessage: null,
      startedAt: null,
      requeueCount: { increment: 1 }
    }
  });

  void poll();

  return {
    jobId,
    previousStatus: job.status
  };
}

export async function startDeploymentQueueWorker(log?: FastifyBaseLogger): Promise<void> {
  if (pollTimer) {
    return;
  }

  fastifyLogger = log ?? null;
  await requeueExpiredRunningJobs();
  await poll();

  pollTimer = setInterval(() => {
    void poll();
  }, appConfig.DEPLOY_QUEUE_POLL_INTERVAL_MS);
}

export function stopDeploymentQueueWorker(): void {
  if (!pollTimer) {
    return;
  }

  clearInterval(pollTimer);
  pollTimer = null;
  fastifyLogger = null;
}
