import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { appConfig } from "../config.js";
import {
  __resetRateLimitHealthForTests,
  rateLimitHealthStats,
  rateLimitPrometheusMetrics,
  recordRateLimitBlockedRequest
} from "./rate-limit-health.js";

afterEach(() => {
  __resetRateLimitHealthForTests();
  appConfig.RATE_LIMIT_ALERT_BLOCKED_REQUESTS_1H_HIGH = 100;
});

describe("rateLimitHealthStats", () => {
  it("tracks blocked requests and thresholded alert status", () => {
    appConfig.RATE_LIMIT_ALERT_BLOCKED_REQUESTS_1H_HIGH = 2;

    recordRateLimitBlockedRequest({ isWebhook: false });
    let stats = rateLimitHealthStats();
    assert.equal(stats.blockedRequestsTotal, 1);
    assert.equal(stats.blockedWebhookRequestsTotal, 0);
    assert.equal(stats.blockedRequestsLastHour, 1);
    assert.equal(stats.alerts.blockedRequestsLastHourHigh, false);
    assert.equal(stats.alerts.requiresAttention, false);

    recordRateLimitBlockedRequest({ isWebhook: true });
    stats = rateLimitHealthStats();
    assert.equal(stats.blockedRequestsTotal, 2);
    assert.equal(stats.blockedWebhookRequestsTotal, 1);
    assert.equal(stats.blockedRequestsLastHour, 2);
    assert.equal(stats.alerts.blockedRequestsLastHourHigh, true);
    assert.equal(stats.alerts.requiresAttention, true);
    assert.equal(stats.alerts.thresholds.blockedRequests1hHigh, 2);
    assert.ok(stats.lastBlockedAt);
  });
});

describe("rateLimitPrometheusMetrics", () => {
  it("includes rate limit alert metrics", () => {
    appConfig.RATE_LIMIT_ALERT_BLOCKED_REQUESTS_1H_HIGH = 1;
    recordRateLimitBlockedRequest({ isWebhook: true });

    const output = rateLimitPrometheusMetrics();
    assert.match(output, /rate_limit_alert_blocked_requests_1hour_high_flag 1/);
    assert.match(output, /rate_limit_alert_requires_attention_flag 1/);
  });
});
