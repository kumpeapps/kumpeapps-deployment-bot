import { appConfig } from "../config.js";

let apiCallsTotal = 0;
let apiCallsSucceededTotal = 0;
let apiFailuresTotal = 0;
let apiTimeoutFailuresTotal = 0;
let vmReadyTimeoutsTotal = 0;
let lastApiSuccessAtMs: number | null = null;
let lastApiFailureAtMs: number | null = null;

let apiFailuresLastHour = 0;
let vmReadyTimeoutsLastHour = 0;
let failureWindowStartMs = Date.now();

function refreshWindow(nowMs: number): void {
  const windowMs = 60 * 60 * 1000;
  if (nowMs - failureWindowStartMs >= windowMs) {
    failureWindowStartMs = nowMs;
    apiFailuresLastHour = 0;
    vmReadyTimeoutsLastHour = 0;
  }
}

export function recordVirtualizorApiCallAttempt(): void {
  apiCallsTotal += 1;
}

export function recordVirtualizorApiCallSuccess(): void {
  apiCallsSucceededTotal += 1;
  lastApiSuccessAtMs = Date.now();
}

export function recordVirtualizorApiCallFailure(input: { timedOut: boolean }): void {
  const nowMs = Date.now();
  refreshWindow(nowMs);

  apiFailuresTotal += 1;
  apiFailuresLastHour += 1;
  lastApiFailureAtMs = nowMs;

  if (input.timedOut) {
    apiTimeoutFailuresTotal += 1;
  }
}

export function recordVirtualizorVmReadyTimeout(): void {
  const nowMs = Date.now();
  refreshWindow(nowMs);
  vmReadyTimeoutsTotal += 1;
  vmReadyTimeoutsLastHour += 1;
}

export function virtualizorHealthStats(): {
  apiCallsTotal: number;
  apiCallsSucceededTotal: number;
  apiFailuresTotal: number;
  apiTimeoutFailuresTotal: number;
  vmReadyTimeoutsTotal: number;
  apiFailuresLastHour: number;
  vmReadyTimeoutsLastHour: number;
  lastApiSuccessAt: string | null;
  lastApiFailureAt: string | null;
  alerts: {
    apiFailuresLastHourHigh: boolean;
    vmReadyTimeoutsLastHourHigh: boolean;
    requiresAttention: boolean;
    thresholds: {
      apiFailures1hHigh: number;
      vmReadyTimeouts1hHigh: number;
    };
  };
} {
  const nowMs = Date.now();
  refreshWindow(nowMs);

  const apiFailuresLastHourHigh =
    apiFailuresLastHour >= appConfig.VIRTUALIZOR_ALERT_API_FAILURES_1H_HIGH;
  const vmReadyTimeoutsLastHourHigh =
    vmReadyTimeoutsLastHour >= appConfig.VIRTUALIZOR_ALERT_VM_READY_TIMEOUTS_1H_HIGH;

  return {
    apiCallsTotal,
    apiCallsSucceededTotal,
    apiFailuresTotal,
    apiTimeoutFailuresTotal,
    vmReadyTimeoutsTotal,
    apiFailuresLastHour,
    vmReadyTimeoutsLastHour,
    lastApiSuccessAt: lastApiSuccessAtMs === null ? null : new Date(lastApiSuccessAtMs).toISOString(),
    lastApiFailureAt: lastApiFailureAtMs === null ? null : new Date(lastApiFailureAtMs).toISOString(),
    alerts: {
      apiFailuresLastHourHigh,
      vmReadyTimeoutsLastHourHigh,
      requiresAttention: apiFailuresLastHourHigh || vmReadyTimeoutsLastHourHigh,
      thresholds: {
        apiFailures1hHigh: appConfig.VIRTUALIZOR_ALERT_API_FAILURES_1H_HIGH,
        vmReadyTimeouts1hHigh: appConfig.VIRTUALIZOR_ALERT_VM_READY_TIMEOUTS_1H_HIGH
      }
    }
  };
}

export function virtualizorPrometheusMetrics(): string {
  const s = virtualizorHealthStats();

  const lines: string[] = [
    "# HELP virtualizor_api_calls_total Total Virtualizor API calls attempted",
    "# TYPE virtualizor_api_calls_total counter",
    `virtualizor_api_calls_total ${s.apiCallsTotal}`,
    "",
    "# HELP virtualizor_api_calls_succeeded_total Total successful Virtualizor API calls",
    "# TYPE virtualizor_api_calls_succeeded_total counter",
    `virtualizor_api_calls_succeeded_total ${s.apiCallsSucceededTotal}`,
    "",
    "# HELP virtualizor_api_failures_total Total Virtualizor API call failures",
    "# TYPE virtualizor_api_failures_total counter",
    `virtualizor_api_failures_total ${s.apiFailuresTotal}`,
    "",
    "# HELP virtualizor_api_timeout_failures_total Total Virtualizor API timeout failures",
    "# TYPE virtualizor_api_timeout_failures_total counter",
    `virtualizor_api_timeout_failures_total ${s.apiTimeoutFailuresTotal}`,
    "",
    "# HELP virtualizor_vm_ready_timeouts_total Total VM ready-state polling timeouts",
    "# TYPE virtualizor_vm_ready_timeouts_total counter",
    `virtualizor_vm_ready_timeouts_total ${s.vmReadyTimeoutsTotal}`,
    "",
    "# HELP virtualizor_api_failures_1hour Virtualizor API failures in last hour",
    "# TYPE virtualizor_api_failures_1hour gauge",
    `virtualizor_api_failures_1hour ${s.apiFailuresLastHour}`,
    "",
    "# HELP virtualizor_vm_ready_timeouts_1hour VM ready-state polling timeouts in last hour",
    "# TYPE virtualizor_vm_ready_timeouts_1hour gauge",
    `virtualizor_vm_ready_timeouts_1hour ${s.vmReadyTimeoutsLastHour}`,
    "",
    "# HELP virtualizor_alert_api_failures_1hour_high_flag Alert flag for high Virtualizor API failures in last hour",
    "# TYPE virtualizor_alert_api_failures_1hour_high_flag gauge",
    `virtualizor_alert_api_failures_1hour_high_flag ${s.alerts.apiFailuresLastHourHigh ? 1 : 0}`,
    "",
    "# HELP virtualizor_alert_vm_ready_timeouts_1hour_high_flag Alert flag for high VM ready timeouts in last hour",
    "# TYPE virtualizor_alert_vm_ready_timeouts_1hour_high_flag gauge",
    `virtualizor_alert_vm_ready_timeouts_1hour_high_flag ${s.alerts.vmReadyTimeoutsLastHourHigh ? 1 : 0}`,
    "",
    "# HELP virtualizor_alert_requires_attention_flag Aggregated Virtualizor alert flag",
    "# TYPE virtualizor_alert_requires_attention_flag gauge",
    `virtualizor_alert_requires_attention_flag ${s.alerts.requiresAttention ? 1 : 0}`,
    ""
  ];

  return lines.join("\n");
}

export function __resetVirtualizorHealthForTests(): void {
  apiCallsTotal = 0;
  apiCallsSucceededTotal = 0;
  apiFailuresTotal = 0;
  apiTimeoutFailuresTotal = 0;
  vmReadyTimeoutsTotal = 0;
  lastApiSuccessAtMs = null;
  lastApiFailureAtMs = null;
  apiFailuresLastHour = 0;
  vmReadyTimeoutsLastHour = 0;
  failureWindowStartMs = Date.now();
}
