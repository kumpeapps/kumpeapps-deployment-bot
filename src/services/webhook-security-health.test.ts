import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { appConfig } from "../config.js";
import {
  __resetWebhookSecurityHealthForTests,
  recordInvalidWebhookSignature,
  webhookSecurityHealthStats,
  webhookSecurityPrometheusMetrics
} from "./webhook-security-health.js";

afterEach(() => {
  __resetWebhookSecurityHealthForTests();
  appConfig.WEBHOOK_ALERT_INVALID_SIGNATURES_1H_HIGH = 20;
});

describe("webhookSecurityHealthStats", () => {
  it("tracks invalid signature counters and alert threshold", () => {
    appConfig.WEBHOOK_ALERT_INVALID_SIGNATURES_1H_HIGH = 2;

    recordInvalidWebhookSignature();
    let stats = webhookSecurityHealthStats();
    assert.equal(stats.invalidSignaturesTotal, 1);
    assert.equal(stats.invalidSignaturesLastHour, 1);
    assert.equal(stats.alerts.invalidSignaturesLastHourHigh, false);
    assert.equal(stats.alerts.requiresAttention, false);

    recordInvalidWebhookSignature();
    stats = webhookSecurityHealthStats();
    assert.equal(stats.invalidSignaturesTotal, 2);
    assert.equal(stats.invalidSignaturesLastHour, 2);
    assert.equal(stats.alerts.invalidSignaturesLastHourHigh, true);
    assert.equal(stats.alerts.requiresAttention, true);
    assert.equal(stats.alerts.thresholds.invalidSignatures1hHigh, 2);
    assert.ok(stats.lastInvalidSignatureAt);
  });
});

describe("webhookSecurityPrometheusMetrics", () => {
  it("includes webhook security alert metrics", () => {
    appConfig.WEBHOOK_ALERT_INVALID_SIGNATURES_1H_HIGH = 1;
    recordInvalidWebhookSignature();

    const output = webhookSecurityPrometheusMetrics();
    assert.match(output, /webhook_security_alert_invalid_signatures_1hour_high_flag 1/);
    assert.match(output, /webhook_security_alert_requires_attention_flag 1/);
  });
});
