import { appConfig } from "../config.js";

let authFailuresTotal = 0;
let missingTokenFailuresTotal = 0;
let authFailuresLastHour = 0;
let windowStartMs = Date.now();
let lastFailureAtMs: number | null = null;

function refreshWindow(nowMs: number): void {
  const windowMs = 60 * 60 * 1000;
  if (nowMs - windowStartMs >= windowMs) {
    windowStartMs = nowMs;
    authFailuresLastHour = 0;
  }
}

export function recordAdminApiAuthFailure(input: { tokenPresent: boolean }): void {
  const nowMs = Date.now();
  refreshWindow(nowMs);

  authFailuresTotal += 1;
  authFailuresLastHour += 1;
  lastFailureAtMs = nowMs;

  if (!input.tokenPresent) {
    missingTokenFailuresTotal += 1;
  }
}

export function adminApiSecurityHealthStats(): {
  authFailuresTotal: number;
  missingTokenFailuresTotal: number;
  authFailuresLastHour: number;
  lastFailureAt: string | null;
  alerts: {
    authFailuresLastHourHigh: boolean;
    requiresAttention: boolean;
    thresholds: {
      authFailures1hHigh: number;
    };
  };
} {
  const nowMs = Date.now();
  refreshWindow(nowMs);

  const authFailuresLastHourHigh = authFailuresLastHour >= appConfig.ADMIN_API_ALERT_AUTH_FAILURES_1H_HIGH;

  return {
    authFailuresTotal,
    missingTokenFailuresTotal,
    authFailuresLastHour,
    lastFailureAt: lastFailureAtMs === null ? null : new Date(lastFailureAtMs).toISOString(),
    alerts: {
      authFailuresLastHourHigh,
      requiresAttention: authFailuresLastHourHigh,
      thresholds: {
        authFailures1hHigh: appConfig.ADMIN_API_ALERT_AUTH_FAILURES_1H_HIGH
      }
    }
  };
}

export function adminApiSecurityPrometheusMetrics(): string {
  const s = adminApiSecurityHealthStats();

  const lines: string[] = [
    "# HELP admin_api_auth_failures_total Total unauthorized admin API requests",
    "# TYPE admin_api_auth_failures_total counter",
    `admin_api_auth_failures_total ${s.authFailuresTotal}`,
    "",
    "# HELP admin_api_missing_token_failures_total Unauthorized admin API requests with missing token",
    "# TYPE admin_api_missing_token_failures_total counter",
    `admin_api_missing_token_failures_total ${s.missingTokenFailuresTotal}`,
    "",
    "# HELP admin_api_auth_failures_1hour Unauthorized admin API requests in last hour",
    "# TYPE admin_api_auth_failures_1hour gauge",
    `admin_api_auth_failures_1hour ${s.authFailuresLastHour}`,
    "",
    "# HELP admin_api_alert_auth_failures_1hour_high_flag Alert flag for high unauthorized admin API requests in last hour",
    "# TYPE admin_api_alert_auth_failures_1hour_high_flag gauge",
    `admin_api_alert_auth_failures_1hour_high_flag ${s.alerts.authFailuresLastHourHigh ? 1 : 0}`,
    "",
    "# HELP admin_api_alert_requires_attention_flag Aggregated admin API security alert flag",
    "# TYPE admin_api_alert_requires_attention_flag gauge",
    `admin_api_alert_requires_attention_flag ${s.alerts.requiresAttention ? 1 : 0}`,
    ""
  ];

  return lines.join("\n");
}

export function __resetAdminApiSecurityHealthForTests(): void {
  authFailuresTotal = 0;
  missingTokenFailuresTotal = 0;
  authFailuresLastHour = 0;
  windowStartMs = Date.now();
  lastFailureAtMs = null;
}
