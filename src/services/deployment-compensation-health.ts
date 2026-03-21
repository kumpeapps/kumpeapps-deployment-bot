import { appConfig } from "../config.js";

type CompensationEvent = {
  at: number;
  state: "planned" | "attempted" | "succeeded" | "failed";
};

let plannedTotal = 0;
let attemptedTotal = 0;
let succeededTotal = 0;
let failedTotal = 0;
const events: CompensationEvent[] = [];

function pruneOld(nowMs: number): void {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  while (events.length > 0 && events[0].at < cutoff) {
    events.shift();
  }
}

export function recordDeploymentCompensationEvent(input: {
  state: "planned" | "attempted" | "succeeded" | "failed";
}): void {
  const nowMs = Date.now();
  pruneOld(nowMs);

  if (input.state === "planned") {
    plannedTotal += 1;
  } else if (input.state === "attempted") {
    attemptedTotal += 1;
  } else if (input.state === "succeeded") {
    succeededTotal += 1;
  } else {
    failedTotal += 1;
  }

  events.push({ at: nowMs, state: input.state });
}

export function deploymentCompensationHealthStats(): {
  totals: {
    planned: number;
    attempted: number;
    succeeded: number;
    failed: number;
  };
  last24h: {
    planned: number;
    attempted: number;
    succeeded: number;
    failed: number;
  };
  alerts: {
    failures24hHigh: boolean;
    requiresAttention: boolean;
    thresholds: {
      failures24hHigh: number;
    };
  };
} {
  const nowMs = Date.now();
  pruneOld(nowMs);

  let planned24h = 0;
  let attempted24h = 0;
  let succeeded24h = 0;
  let failed24h = 0;

  for (const event of events) {
    if (event.state === "planned") {
      planned24h += 1;
    } else if (event.state === "attempted") {
      attempted24h += 1;
    } else if (event.state === "succeeded") {
      succeeded24h += 1;
    } else {
      failed24h += 1;
    }
  }

  const failures24hHigh = failed24h >= appConfig.DEPLOY_COMPENSATION_ALERT_FAILURES_24H_HIGH;

  return {
    totals: {
      planned: plannedTotal,
      attempted: attemptedTotal,
      succeeded: succeededTotal,
      failed: failedTotal
    },
    last24h: {
      planned: planned24h,
      attempted: attempted24h,
      succeeded: succeeded24h,
      failed: failed24h
    },
    alerts: {
      failures24hHigh,
      requiresAttention: failures24hHigh,
      thresholds: {
        failures24hHigh: appConfig.DEPLOY_COMPENSATION_ALERT_FAILURES_24H_HIGH
      }
    }
  };
}

export function deploymentCompensationPrometheusMetrics(): string {
  const s = deploymentCompensationHealthStats();
  return [
    "# HELP deployment_compensation_events_planned_total Total planned compensation actions",
    "# TYPE deployment_compensation_events_planned_total counter",
    `deployment_compensation_events_planned_total ${s.totals.planned}`,
    "",
    "# HELP deployment_compensation_events_attempted_total Total attempted compensation actions",
    "# TYPE deployment_compensation_events_attempted_total counter",
    `deployment_compensation_events_attempted_total ${s.totals.attempted}`,
    "",
    "# HELP deployment_compensation_events_succeeded_total Total succeeded compensation actions",
    "# TYPE deployment_compensation_events_succeeded_total counter",
    `deployment_compensation_events_succeeded_total ${s.totals.succeeded}`,
    "",
    "# HELP deployment_compensation_events_failed_total Total failed compensation actions",
    "# TYPE deployment_compensation_events_failed_total counter",
    `deployment_compensation_events_failed_total ${s.totals.failed}`,
    "",
    "# HELP deployment_compensation_failures_24h Compensation action failures in last 24h",
    "# TYPE deployment_compensation_failures_24h gauge",
    `deployment_compensation_failures_24h ${s.last24h.failed}`,
    "",
    "# HELP deployment_compensation_alert_failures_24h_high_flag Alert flag for high compensation failures in last 24h",
    "# TYPE deployment_compensation_alert_failures_24h_high_flag gauge",
    `deployment_compensation_alert_failures_24h_high_flag ${s.alerts.failures24hHigh ? 1 : 0}`,
    "",
    "# HELP deployment_compensation_alert_requires_attention_flag Aggregated compensation alert flag",
    "# TYPE deployment_compensation_alert_requires_attention_flag gauge",
    `deployment_compensation_alert_requires_attention_flag ${s.alerts.requiresAttention ? 1 : 0}`
  ].join("\n");
}

export function resetDeploymentCompensationHealthForTests(): void {
  plannedTotal = 0;
  attemptedTotal = 0;
  succeededTotal = 0;
  failedTotal = 0;
  events.splice(0, events.length);
}
