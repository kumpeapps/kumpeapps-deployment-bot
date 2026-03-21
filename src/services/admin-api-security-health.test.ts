import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { appConfig } from "../config.js";
import {
  __resetAdminApiSecurityHealthForTests,
  adminApiSecurityHealthStats,
  adminApiSecurityPrometheusMetrics,
  recordAdminApiAuthFailure
} from "./admin-api-security-health.js";

afterEach(() => {
  __resetAdminApiSecurityHealthForTests();
  appConfig.ADMIN_API_ALERT_AUTH_FAILURES_1H_HIGH = 20;
});

describe("adminApiSecurityHealthStats", () => {
  it("tracks auth failures and thresholded alert state", () => {
    appConfig.ADMIN_API_ALERT_AUTH_FAILURES_1H_HIGH = 2;

    recordAdminApiAuthFailure({ tokenPresent: false });
    let stats = adminApiSecurityHealthStats();
    assert.equal(stats.authFailuresTotal, 1);
    assert.equal(stats.missingTokenFailuresTotal, 1);
    assert.equal(stats.authFailuresLastHour, 1);
    assert.equal(stats.alerts.authFailuresLastHourHigh, false);
    assert.equal(stats.alerts.requiresAttention, false);

    recordAdminApiAuthFailure({ tokenPresent: true });
    stats = adminApiSecurityHealthStats();
    assert.equal(stats.authFailuresTotal, 2);
    assert.equal(stats.missingTokenFailuresTotal, 1);
    assert.equal(stats.authFailuresLastHour, 2);
    assert.equal(stats.alerts.authFailuresLastHourHigh, true);
    assert.equal(stats.alerts.requiresAttention, true);
    assert.equal(stats.alerts.thresholds.authFailures1hHigh, 2);
    assert.ok(stats.lastFailureAt);
  });
});

describe("adminApiSecurityPrometheusMetrics", () => {
  it("includes admin api security alert flags", () => {
    appConfig.ADMIN_API_ALERT_AUTH_FAILURES_1H_HIGH = 1;
    recordAdminApiAuthFailure({ tokenPresent: false });

    const output = adminApiSecurityPrometheusMetrics();
    assert.match(output, /admin_api_alert_auth_failures_1hour_high_flag 1/);
    assert.match(output, /admin_api_alert_requires_attention_flag 1/);
  });
});
