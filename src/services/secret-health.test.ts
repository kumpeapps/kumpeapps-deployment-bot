import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { appConfig } from "../config.js";
import {
  __resetSecretEncryptionHealthForTests,
  recordSecretDecryptFailure,
  secretEncryptionHealthStats,
  secretEncryptionPrometheusMetrics
} from "./secret-health.js";

afterEach(() => {
  __resetSecretEncryptionHealthForTests();
  appConfig.SECRET_ENCRYPTION_PREVIOUS_KEYS = "";
  appConfig.SECRET_ENCRYPTION_ALERT_DECRYPT_FAILURES_1H_HIGH = 3;
});

describe("secretEncryptionHealthStats", () => {
  it("tracks decrypt failures and updates alert flags", () => {
    appConfig.SECRET_ENCRYPTION_ALERT_DECRYPT_FAILURES_1H_HIGH = 2;

    recordSecretDecryptFailure();
    let stats = secretEncryptionHealthStats();
    assert.equal(stats.decryptFailuresTotal, 1);
    assert.equal(stats.decryptFailuresLastHour, 1);
    assert.equal(stats.alerts.decryptFailuresLastHourHigh, false);
    assert.equal(stats.alerts.requiresAttention, false);

    recordSecretDecryptFailure();
    stats = secretEncryptionHealthStats();
    assert.equal(stats.decryptFailuresTotal, 2);
    assert.equal(stats.decryptFailuresLastHour, 2);
    assert.equal(stats.alerts.decryptFailuresLastHourHigh, true);
    assert.equal(stats.alerts.requiresAttention, true);
    assert.equal(stats.alerts.thresholds.decryptFailures1hHigh, 2);
    assert.ok(stats.lastDecryptFailureAt);
  });

  it("counts configured fallback keys", () => {
    appConfig.SECRET_ENCRYPTION_PREVIOUS_KEYS = " old-key-aaaaaaaaaaaaa , , old-key-bbbbbbbbbbbbb ";

    const stats = secretEncryptionHealthStats();
    assert.equal(stats.fallbackKeysConfigured, 2);
  });
});

describe("secretEncryptionPrometheusMetrics", () => {
  it("includes secret encryption alert flag metrics", () => {
    appConfig.SECRET_ENCRYPTION_ALERT_DECRYPT_FAILURES_1H_HIGH = 1;
    recordSecretDecryptFailure();

    const output = secretEncryptionPrometheusMetrics();
    assert.match(output, /secret_encryption_alert_decrypt_failures_1hour_high_flag 1/);
    assert.match(output, /secret_encryption_alert_requires_attention_flag 1/);
  });
});
