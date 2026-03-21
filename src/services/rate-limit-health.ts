import { appConfig } from "../config.js";

let blockedRequestsTotal = 0;
let blockedWebhookRequestsTotal = 0;
let blockedRequestsLastHour = 0;
let windowStartMs = Date.now();
let lastBlockedAtMs: number | null = null;

function refreshWindow(nowMs: number): void {
  const windowMs = 60 * 60 * 1000;
  if (nowMs - windowStartMs >= windowMs) {
    windowStartMs = nowMs;
    blockedRequestsLastHour = 0;
  }
}

export function recordRateLimitBlockedRequest(input: { isWebhook: boolean }): void {
  const nowMs = Date.now();
  refreshWindow(nowMs);

  blockedRequestsTotal += 1;
  blockedRequestsLastHour += 1;
  lastBlockedAtMs = nowMs;

  if (input.isWebhook) {
    blockedWebhookRequestsTotal += 1;
  }
}

export function rateLimitHealthStats(): {
  blockedRequestsTotal: number;
  blockedWebhookRequestsTotal: number;
  blockedRequestsLastHour: number;
  lastBlockedAt: string | null;
  alerts: {
    blockedRequestsLastHourHigh: boolean;
    requiresAttention: boolean;
    thresholds: {
      blockedRequests1hHigh: number;
    };
  };
} {
  const nowMs = Date.now();
  refreshWindow(nowMs);

  const blockedRequestsLastHourHigh =
    blockedRequestsLastHour >= appConfig.RATE_LIMIT_ALERT_BLOCKED_REQUESTS_1H_HIGH;

  return {
    blockedRequestsTotal,
    blockedWebhookRequestsTotal,
    blockedRequestsLastHour,
    lastBlockedAt: lastBlockedAtMs === null ? null : new Date(lastBlockedAtMs).toISOString(),
    alerts: {
      blockedRequestsLastHourHigh,
      requiresAttention: blockedRequestsLastHourHigh,
      thresholds: {
        blockedRequests1hHigh: appConfig.RATE_LIMIT_ALERT_BLOCKED_REQUESTS_1H_HIGH
      }
    }
  };
}

export function rateLimitPrometheusMetrics(): string {
  const s = rateLimitHealthStats();

  const lines: string[] = [
    "# HELP rate_limit_blocked_requests_total Total requests blocked by rate limiting",
    "# TYPE rate_limit_blocked_requests_total counter",
    `rate_limit_blocked_requests_total ${s.blockedRequestsTotal}`,
    "",
    "# HELP rate_limit_blocked_webhook_requests_total Total webhook requests blocked by rate limiting",
    "# TYPE rate_limit_blocked_webhook_requests_total counter",
    `rate_limit_blocked_webhook_requests_total ${s.blockedWebhookRequestsTotal}`,
    "",
    "# HELP rate_limit_blocked_requests_1hour Requests blocked by rate limiting in last hour",
    "# TYPE rate_limit_blocked_requests_1hour gauge",
    `rate_limit_blocked_requests_1hour ${s.blockedRequestsLastHour}`,
    "",
    "# HELP rate_limit_alert_blocked_requests_1hour_high_flag Alert flag for high blocked request volume",
    "# TYPE rate_limit_alert_blocked_requests_1hour_high_flag gauge",
    `rate_limit_alert_blocked_requests_1hour_high_flag ${s.alerts.blockedRequestsLastHourHigh ? 1 : 0}`,
    "",
    "# HELP rate_limit_alert_requires_attention_flag Aggregated rate-limit alert flag",
    "# TYPE rate_limit_alert_requires_attention_flag gauge",
    `rate_limit_alert_requires_attention_flag ${s.alerts.requiresAttention ? 1 : 0}`,
    ""
  ];

  return lines.join("\n");
}

export function __resetRateLimitHealthForTests(): void {
  blockedRequestsTotal = 0;
  blockedWebhookRequestsTotal = 0;
  blockedRequestsLastHour = 0;
  windowStartMs = Date.now();
  lastBlockedAtMs = null;
}
