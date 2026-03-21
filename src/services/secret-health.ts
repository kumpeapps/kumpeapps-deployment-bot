import { appConfig } from "../config.js";

type SecretDecryptFailureContext = {
  repositoryId?: number;
  secretName?: string;
  reason?: string;
};

let secretDecryptFailuresTotal = 0;
let secretDecryptLastFailureAtMs: number | null = null;
let secretDecryptRecentFailures = 0;
let secretDecryptRecentWindowStartMs = Date.now();

function refreshRecentWindow(nowMs: number): void {
  const windowMs = 60 * 60 * 1000;
  if (nowMs - secretDecryptRecentWindowStartMs >= windowMs) {
    secretDecryptRecentWindowStartMs = nowMs;
    secretDecryptRecentFailures = 0;
  }
}

export function recordSecretDecryptFailure(_context?: SecretDecryptFailureContext): void {
  const nowMs = Date.now();
  refreshRecentWindow(nowMs);
  secretDecryptFailuresTotal += 1;
  secretDecryptRecentFailures += 1;
  secretDecryptLastFailureAtMs = nowMs;
}

export function secretEncryptionHealthStats(): {
  decryptFailuresTotal: number;
  decryptFailuresLastHour: number;
  lastDecryptFailureAt: string | null;
  fallbackKeysConfigured: number;
  alerts: {
    decryptFailuresLastHourHigh: boolean;
    requiresAttention: boolean;
    thresholds: {
      decryptFailures1hHigh: number;
    };
  };
} {
  const nowMs = Date.now();
  refreshRecentWindow(nowMs);

  const fallbackKeysConfigured = appConfig.SECRET_ENCRYPTION_PREVIOUS_KEYS.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0).length;

  const decryptFailuresLastHourHigh =
    secretDecryptRecentFailures >= appConfig.SECRET_ENCRYPTION_ALERT_DECRYPT_FAILURES_1H_HIGH;

  return {
    decryptFailuresTotal: secretDecryptFailuresTotal,
    decryptFailuresLastHour: secretDecryptRecentFailures,
    lastDecryptFailureAt: secretDecryptLastFailureAtMs === null ? null : new Date(secretDecryptLastFailureAtMs).toISOString(),
    fallbackKeysConfigured,
    alerts: {
      decryptFailuresLastHourHigh,
      requiresAttention: decryptFailuresLastHourHigh,
      thresholds: {
        decryptFailures1hHigh: appConfig.SECRET_ENCRYPTION_ALERT_DECRYPT_FAILURES_1H_HIGH
      }
    }
  };
}

export function secretEncryptionPrometheusMetrics(): string {
  const stats = secretEncryptionHealthStats();

  const lines: string[] = [
    "# HELP secret_encryption_decrypt_failures_total Total secret decryption failures observed by this process",
    "# TYPE secret_encryption_decrypt_failures_total counter",
    `secret_encryption_decrypt_failures_total ${stats.decryptFailuresTotal}`,
    "",
    "# HELP secret_encryption_decrypt_failures_1hour Secret decryption failures during the last hour window",
    "# TYPE secret_encryption_decrypt_failures_1hour gauge",
    `secret_encryption_decrypt_failures_1hour ${stats.decryptFailuresLastHour}`,
    "",
    "# HELP secret_encryption_fallback_keys_configured Number of previous encryption keys configured for fallback decrypt",
    "# TYPE secret_encryption_fallback_keys_configured gauge",
    `secret_encryption_fallback_keys_configured ${stats.fallbackKeysConfigured}`,
    "",
    "# HELP secret_encryption_alert_decrypt_failures_1hour_high_flag Alert flag for high secret decrypt failures in last hour",
    "# TYPE secret_encryption_alert_decrypt_failures_1hour_high_flag gauge",
    `secret_encryption_alert_decrypt_failures_1hour_high_flag ${stats.alerts.decryptFailuresLastHourHigh ? 1 : 0}`,
    "",
    "# HELP secret_encryption_alert_requires_attention_flag Aggregated secret encryption alert flag",
    "# TYPE secret_encryption_alert_requires_attention_flag gauge",
    `secret_encryption_alert_requires_attention_flag ${stats.alerts.requiresAttention ? 1 : 0}`,
    ""
  ];

  return lines.join("\n");
}

export function __resetSecretEncryptionHealthForTests(): void {
  secretDecryptFailuresTotal = 0;
  secretDecryptLastFailureAtMs = null;
  secretDecryptRecentFailures = 0;
  secretDecryptRecentWindowStartMs = Date.now();
}
