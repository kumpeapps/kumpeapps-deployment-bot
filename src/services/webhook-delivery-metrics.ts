import { prisma } from "../db.js";
import { appConfig } from "../config.js";

export async function webhookDeliveryStats(): Promise<{
  totalTracked: number;
  processed: number;
  failed: number;
  inProgress: number;
  duplicateSuppressionsTotal: number;
  staleReclaimsTotal: number;
  processedLast24h: number;
  failedLast24h: number;
  duplicateSuppressionsLast24h: number;
  staleReclaimsLast24h: number;
  alerts: {
    failed24hHigh: boolean;
    inProgressHigh: boolean;
    staleReclaims24hHigh: boolean;
    duplicateSuppressions24hHigh: boolean;
    requiresAttention: boolean;
    thresholds: {
      failed24hHigh: number;
      inProgressHigh: number;
      staleReclaims24hHigh: number;
      duplicateSuppressions24hHigh: number;
    };
  };
}> {
  const grouped = await prisma.githubWebhookDelivery.groupBy({
    by: ["processStatus"],
    _count: { _all: true }
  });

  const counts = new Map<string, number>(
    grouped.map((item: { processStatus: string; _count: { _all: number } }) => [item.processStatus, item._count._all])
  );

  const sums = await prisma.githubWebhookDelivery.aggregate({
    _sum: {
      duplicateCount: true,
      staleReclaims: true
    }
  });

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const processedLast24h = await prisma.githubWebhookDelivery.count({
    where: {
      processStatus: "processed",
      processedAt: { gte: oneDayAgo }
    }
  });

  const failedLast24h = await prisma.githubWebhookDelivery.count({
    where: {
      processStatus: "failed",
      lastAttemptAt: { gte: oneDayAgo }
    }
  });

  const sumsLast24h = await prisma.githubWebhookDelivery.aggregate({
    where: {
      lastAttemptAt: { gte: oneDayAgo }
    },
    _sum: {
      duplicateCount: true,
      staleReclaims: true
    }
  });

  const processed = counts.get("processed") ?? 0;
  const failed = counts.get("failed") ?? 0;
  const inProgress = counts.get("in_progress") ?? 0;

  const duplicateSuppressionsLast24h = sumsLast24h._sum.duplicateCount ?? 0;
  const staleReclaimsLast24h = sumsLast24h._sum.staleReclaims ?? 0;
  const failed24hHigh = failedLast24h >= appConfig.WEBHOOK_ALERT_FAILED_24H_HIGH;
  const inProgressHigh = inProgress >= appConfig.WEBHOOK_ALERT_IN_PROGRESS_HIGH;
  const staleReclaims24hHigh = staleReclaimsLast24h >= appConfig.WEBHOOK_ALERT_STALE_RECLAIMS_24H_HIGH;
  const duplicateSuppressions24hHigh =
    duplicateSuppressionsLast24h >= appConfig.WEBHOOK_ALERT_DUPLICATE_SUPPRESSIONS_24H_HIGH;
  const requiresAttention = failed24hHigh || inProgressHigh || staleReclaims24hHigh || duplicateSuppressions24hHigh;

  return {
    totalTracked: processed + failed + inProgress,
    processed,
    failed,
    inProgress,
    duplicateSuppressionsTotal: sums._sum.duplicateCount ?? 0,
    staleReclaimsTotal: sums._sum.staleReclaims ?? 0,
    processedLast24h,
    failedLast24h,
    duplicateSuppressionsLast24h,
    staleReclaimsLast24h,
    alerts: {
      failed24hHigh,
      inProgressHigh,
      staleReclaims24hHigh,
      duplicateSuppressions24hHigh,
      requiresAttention,
      thresholds: {
        failed24hHigh: appConfig.WEBHOOK_ALERT_FAILED_24H_HIGH,
        inProgressHigh: appConfig.WEBHOOK_ALERT_IN_PROGRESS_HIGH,
        staleReclaims24hHigh: appConfig.WEBHOOK_ALERT_STALE_RECLAIMS_24H_HIGH,
        duplicateSuppressions24hHigh: appConfig.WEBHOOK_ALERT_DUPLICATE_SUPPRESSIONS_24H_HIGH
      }
    }
  };
}

export async function webhookDeliveryPrometheusMetrics(): Promise<string> {
  const s = await webhookDeliveryStats();

  const lines: string[] = [
    "# HELP webhook_delivery_tracked_total Total webhook deliveries tracked for idempotency",
    "# TYPE webhook_delivery_tracked_total gauge",
    `webhook_delivery_tracked_total ${s.totalTracked}`,
    "",
    "# HELP webhook_delivery_processed_total Total processed webhook deliveries",
    "# TYPE webhook_delivery_processed_total gauge",
    `webhook_delivery_processed_total ${s.processed}`,
    "",
    "# HELP webhook_delivery_failed_total Total failed webhook deliveries",
    "# TYPE webhook_delivery_failed_total gauge",
    `webhook_delivery_failed_total ${s.failed}`,
    "",
    "# HELP webhook_delivery_in_progress_total Total in-progress webhook deliveries",
    "# TYPE webhook_delivery_in_progress_total gauge",
    `webhook_delivery_in_progress_total ${s.inProgress}`,
    "",
    "# HELP webhook_delivery_duplicate_suppressions_total Total duplicate webhook deliveries suppressed",
    "# TYPE webhook_delivery_duplicate_suppressions_total counter",
    `webhook_delivery_duplicate_suppressions_total ${s.duplicateSuppressionsTotal}`,
    "",
    "# HELP webhook_delivery_stale_reclaims_total Total stale in-progress deliveries reclaimed",
    "# TYPE webhook_delivery_stale_reclaims_total counter",
    `webhook_delivery_stale_reclaims_total ${s.staleReclaimsTotal}`,
    "",
    "# HELP webhook_delivery_processed_24h_total Processed webhook deliveries in last 24h",
    "# TYPE webhook_delivery_processed_24h_total gauge",
    `webhook_delivery_processed_24h_total ${s.processedLast24h}`,
    "",
    "# HELP webhook_delivery_failed_24h_total Failed webhook deliveries in last 24h",
    "# TYPE webhook_delivery_failed_24h_total gauge",
    `webhook_delivery_failed_24h_total ${s.failedLast24h}`,
    "",
    "# HELP webhook_delivery_duplicate_suppressions_24h_total Duplicate suppressions in last 24h",
    "# TYPE webhook_delivery_duplicate_suppressions_24h_total gauge",
    `webhook_delivery_duplicate_suppressions_24h_total ${s.duplicateSuppressionsLast24h}`,
    "",
    "# HELP webhook_delivery_stale_reclaims_24h_total Stale in-progress reclaims in last 24h",
    "# TYPE webhook_delivery_stale_reclaims_24h_total gauge",
    `webhook_delivery_stale_reclaims_24h_total ${s.staleReclaimsLast24h}`,
    "",
    "# HELP webhook_delivery_alert_failed_24h_high_flag Alert flag for failed webhooks in last 24h",
    "# TYPE webhook_delivery_alert_failed_24h_high_flag gauge",
    `webhook_delivery_alert_failed_24h_high_flag ${s.alerts.failed24hHigh ? 1 : 0}`,
    "",
    "# HELP webhook_delivery_alert_in_progress_high_flag Alert flag for high in-progress webhook deliveries",
    "# TYPE webhook_delivery_alert_in_progress_high_flag gauge",
    `webhook_delivery_alert_in_progress_high_flag ${s.alerts.inProgressHigh ? 1 : 0}`,
    "",
    "# HELP webhook_delivery_alert_stale_reclaims_24h_high_flag Alert flag for high stale reclaim count",
    "# TYPE webhook_delivery_alert_stale_reclaims_24h_high_flag gauge",
    `webhook_delivery_alert_stale_reclaims_24h_high_flag ${s.alerts.staleReclaims24hHigh ? 1 : 0}`,
    "",
    "# HELP webhook_delivery_alert_duplicate_suppressions_24h_high_flag Alert flag for high duplicate suppressions",
    "# TYPE webhook_delivery_alert_duplicate_suppressions_24h_high_flag gauge",
    `webhook_delivery_alert_duplicate_suppressions_24h_high_flag ${s.alerts.duplicateSuppressions24hHigh ? 1 : 0}`,
    "",
    "# HELP webhook_delivery_alert_requires_attention_flag Aggregated webhook delivery alert flag",
    "# TYPE webhook_delivery_alert_requires_attention_flag gauge",
    `webhook_delivery_alert_requires_attention_flag ${s.alerts.requiresAttention ? 1 : 0}`,
    ""
  ];

  return lines.join("\n");
}
