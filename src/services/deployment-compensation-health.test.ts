import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  deploymentCompensationHealthStats,
  deploymentCompensationPrometheusMetrics,
  recordDeploymentCompensationEvent,
  resetDeploymentCompensationHealthForTests
} from "./deployment-compensation-health.js";

describe("deploymentCompensationHealthStats", () => {
  beforeEach(() => {
    resetDeploymentCompensationHealthForTests();
  });

  it("tracks compensation event counters and alert state", () => {
    recordDeploymentCompensationEvent({ state: "planned" });
    recordDeploymentCompensationEvent({ state: "attempted" });
    recordDeploymentCompensationEvent({ state: "failed" });

    const stats = deploymentCompensationHealthStats();
    assert.equal(stats.totals.planned, 1);
    assert.equal(stats.totals.attempted, 1);
    assert.equal(stats.totals.succeeded, 0);
    assert.equal(stats.totals.failed, 1);
    assert.equal(stats.last24h.failed, 1);
    assert.equal(stats.alerts.failures24hHigh, false);
  });
});

describe("deploymentCompensationPrometheusMetrics", () => {
  beforeEach(() => {
    resetDeploymentCompensationHealthForTests();
  });

  it("includes compensation counters and alert flags", () => {
    recordDeploymentCompensationEvent({ state: "planned" });
    recordDeploymentCompensationEvent({ state: "attempted" });
    recordDeploymentCompensationEvent({ state: "succeeded" });

    const output = deploymentCompensationPrometheusMetrics();
    assert.match(output, /deployment_compensation_events_planned_total 1/);
    assert.match(output, /deployment_compensation_events_attempted_total 1/);
    assert.match(output, /deployment_compensation_events_succeeded_total 1/);
    assert.match(output, /deployment_compensation_events_failed_total 0/);
    assert.match(output, /deployment_compensation_alert_requires_attention_flag 0/);
  });
});
