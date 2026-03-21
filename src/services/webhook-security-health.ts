import { appConfig } from "../config.js";

let invalidSignaturesTotal = 0;
let invalidSignaturesLastHour = 0;
let invalidSignaturesWindowStartMs = Date.now();
let lastInvalidSignatureAtMs: number | null = null;

function refreshWindow(nowMs: number): void {
  const windowMs = 60 * 60 * 1000;
  if (nowMs - invalidSignaturesWindowStartMs >= windowMs) {
    invalidSignaturesWindowStartMs = nowMs;
    invalidSignaturesLastHour = 0;
  }
}

export function recordInvalidWebhookSignature(): void {
  const nowMs = Date.now();
  refreshWindow(nowMs);
  invalidSignaturesTotal += 1;
  invalidSignaturesLastHour += 1;
  lastInvalidSignatureAtMs = nowMs;
}

export function webhookSecurityHealthStats(): {
  invalidSignaturesTotal: number;
  invalidSignaturesLastHour: number;
  lastInvalidSignatureAt: string | null;
  alerts: {
    invalidSignaturesLastHourHigh: boolean;
    requiresAttention: boolean;
    thresholds: {
      invalidSignatures1hHigh: number;
    };
  };
} {
  const nowMs = Date.now();
  refreshWindow(nowMs);

  const invalidSignaturesLastHourHigh =
    invalidSignaturesLastHour >= appConfig.WEBHOOK_ALERT_INVALID_SIGNATURES_1H_HIGH;

  return {
    invalidSignaturesTotal,
    invalidSignaturesLastHour,
    lastInvalidSignatureAt: lastInvalidSignatureAtMs === null ? null : new Date(lastInvalidSignatureAtMs).toISOString(),
    alerts: {
      invalidSignaturesLastHourHigh,
      requiresAttention: invalidSignaturesLastHourHigh,
      thresholds: {
        invalidSignatures1hHigh: appConfig.WEBHOOK_ALERT_INVALID_SIGNATURES_1H_HIGH
      }
    }
  };
}

export function webhookSecurityPrometheusMetrics(): string {
  const s = webhookSecurityHealthStats();

  const lines: string[] = [
    "# HELP webhook_security_invalid_signatures_total Total webhook requests rejected due to invalid signatures",
    "# TYPE webhook_security_invalid_signatures_total counter",
    `webhook_security_invalid_signatures_total ${s.invalidSignaturesTotal}`,
    "",
    "# HELP webhook_security_invalid_signatures_1hour Invalid webhook signatures in last hour",
    "# TYPE webhook_security_invalid_signatures_1hour gauge",
    `webhook_security_invalid_signatures_1hour ${s.invalidSignaturesLastHour}`,
    "",
    "# HELP webhook_security_alert_invalid_signatures_1hour_high_flag Alert flag for high invalid webhook signatures in last hour",
    "# TYPE webhook_security_alert_invalid_signatures_1hour_high_flag gauge",
    `webhook_security_alert_invalid_signatures_1hour_high_flag ${s.alerts.invalidSignaturesLastHourHigh ? 1 : 0}`,
    "",
    "# HELP webhook_security_alert_requires_attention_flag Aggregated webhook security alert flag",
    "# TYPE webhook_security_alert_requires_attention_flag gauge",
    `webhook_security_alert_requires_attention_flag ${s.alerts.requiresAttention ? 1 : 0}`,
    ""
  ];

  return lines.join("\n");
}

export function __resetWebhookSecurityHealthForTests(): void {
  invalidSignaturesTotal = 0;
  invalidSignaturesLastHour = 0;
  invalidSignaturesWindowStartMs = Date.now();
  lastInvalidSignatureAtMs = null;
}
