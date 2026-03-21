import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { appConfig } from "../config.js";
import {
  __resetSshHealthForTests,
  recordSshCommandAttempt,
  recordSshCommandFinalFailure,
  recordSshCommandSuccess,
  sshHealthStats,
  sshPrometheusMetrics
} from "./ssh-health.js";

afterEach(() => {
  __resetSshHealthForTests();
  appConfig.SSH_ALERT_FINAL_FAILURES_1H_HIGH = 10;
  appConfig.SSH_ALERT_TIMEOUT_FAILURES_1H_HIGH = 3;
});

describe("sshHealthStats", () => {
  it("tracks attempts, retries, successes, and failures", () => {
    appConfig.SSH_ALERT_FINAL_FAILURES_1H_HIGH = 1;

    recordSshCommandAttempt({ isRetry: false });
    recordSshCommandAttempt({ isRetry: true });
    recordSshCommandSuccess();
    recordSshCommandFinalFailure({ timedOut: true });

    const stats = sshHealthStats();
    assert.equal(stats.attemptsTotal, 2);
    assert.equal(stats.retriesTotal, 1);
    assert.equal(stats.succeededTotal, 1);
    assert.equal(stats.finalFailuresTotal, 1);
    assert.equal(stats.timeoutFailuresTotal, 1);
    assert.equal(stats.finalFailuresLastHour, 1);
    assert.equal(stats.timeoutFailuresLastHour, 1);
    assert.equal(stats.alerts.finalFailuresLastHourHigh, true);
    assert.equal(stats.alerts.requiresAttention, true);
    assert.ok(stats.lastSuccessAt);
    assert.ok(stats.lastFailureAt);
  });

  it("activates timeout alert threshold independently", () => {
    appConfig.SSH_ALERT_FINAL_FAILURES_1H_HIGH = 10;
    appConfig.SSH_ALERT_TIMEOUT_FAILURES_1H_HIGH = 1;

    recordSshCommandAttempt({ isRetry: false });
    recordSshCommandFinalFailure({ timedOut: true });

    const stats = sshHealthStats();
    assert.equal(stats.alerts.finalFailuresLastHourHigh, false);
    assert.equal(stats.alerts.timeoutFailuresLastHourHigh, true);
    assert.equal(stats.alerts.requiresAttention, true);
  });
});

describe("sshPrometheusMetrics", () => {
  it("includes SSH alert flag metrics", () => {
    appConfig.SSH_ALERT_FINAL_FAILURES_1H_HIGH = 1;

    recordSshCommandAttempt({ isRetry: false });
    recordSshCommandFinalFailure({ timedOut: false });

    const output = sshPrometheusMetrics();
    assert.match(output, /ssh_alert_final_failures_1hour_high_flag 1/);
    assert.match(output, /ssh_alert_requires_attention_flag 1/);
  });
});
