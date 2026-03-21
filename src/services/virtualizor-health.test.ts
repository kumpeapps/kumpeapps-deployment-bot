import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { appConfig } from "../config.js";
import {
  __resetVirtualizorHealthForTests,
  recordVirtualizorApiCallAttempt,
  recordVirtualizorApiCallFailure,
  recordVirtualizorApiCallSuccess,
  recordVirtualizorVmReadyTimeout,
  virtualizorHealthStats,
  virtualizorPrometheusMetrics
} from "./virtualizor-health.js";

afterEach(() => {
  __resetVirtualizorHealthForTests();
  appConfig.VIRTUALIZOR_ALERT_API_FAILURES_1H_HIGH = 10;
  appConfig.VIRTUALIZOR_ALERT_VM_READY_TIMEOUTS_1H_HIGH = 3;
});

describe("virtualizorHealthStats", () => {
  it("tracks api success/failure counters and alert threshold", () => {
    appConfig.VIRTUALIZOR_ALERT_API_FAILURES_1H_HIGH = 1;

    recordVirtualizorApiCallAttempt();
    recordVirtualizorApiCallFailure({ timedOut: true });
    recordVirtualizorApiCallAttempt();
    recordVirtualizorApiCallSuccess();

    const stats = virtualizorHealthStats();
    assert.equal(stats.apiCallsTotal, 2);
    assert.equal(stats.apiCallsSucceededTotal, 1);
    assert.equal(stats.apiFailuresTotal, 1);
    assert.equal(stats.apiTimeoutFailuresTotal, 1);
    assert.equal(stats.apiFailuresLastHour, 1);
    assert.equal(stats.alerts.apiFailuresLastHourHigh, true);
    assert.equal(stats.alerts.requiresAttention, true);
    assert.ok(stats.lastApiSuccessAt);
    assert.ok(stats.lastApiFailureAt);
  });

  it("tracks vm ready timeout threshold independently", () => {
    appConfig.VIRTUALIZOR_ALERT_API_FAILURES_1H_HIGH = 10;
    appConfig.VIRTUALIZOR_ALERT_VM_READY_TIMEOUTS_1H_HIGH = 1;

    recordVirtualizorVmReadyTimeout();

    const stats = virtualizorHealthStats();
    assert.equal(stats.vmReadyTimeoutsTotal, 1);
    assert.equal(stats.vmReadyTimeoutsLastHour, 1);
    assert.equal(stats.alerts.apiFailuresLastHourHigh, false);
    assert.equal(stats.alerts.vmReadyTimeoutsLastHourHigh, true);
    assert.equal(stats.alerts.requiresAttention, true);
  });
});

describe("virtualizorPrometheusMetrics", () => {
  it("includes virtualizor alert flags", () => {
    appConfig.VIRTUALIZOR_ALERT_API_FAILURES_1H_HIGH = 1;

    recordVirtualizorApiCallAttempt();
    recordVirtualizorApiCallFailure({ timedOut: false });

    const output = virtualizorPrometheusMetrics();
    assert.match(output, /virtualizor_alert_api_failures_1hour_high_flag 1/);
    assert.match(output, /virtualizor_alert_requires_attention_flag 1/);
  });
});
