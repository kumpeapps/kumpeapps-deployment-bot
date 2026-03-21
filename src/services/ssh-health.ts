import { appConfig } from "../config.js";

let sshCommandAttemptsTotal = 0;
let sshCommandSucceededTotal = 0;
let sshCommandRetriesTotal = 0;
let sshCommandFinalFailuresTotal = 0;
let sshCommandTimeoutFailuresTotal = 0;
let sshCommandLastSuccessAtMs: number | null = null;
let sshCommandLastFailureAtMs: number | null = null;

let sshFailuresLastHour = 0;
let sshTimeoutFailuresLastHour = 0;
let sshFailureWindowStartMs = Date.now();

function refreshFailureWindow(nowMs: number): void {
  const windowMs = 60 * 60 * 1000;
  if (nowMs - sshFailureWindowStartMs >= windowMs) {
    sshFailureWindowStartMs = nowMs;
    sshFailuresLastHour = 0;
    sshTimeoutFailuresLastHour = 0;
  }
}

export function recordSshCommandAttempt(input: { isRetry: boolean }): void {
  sshCommandAttemptsTotal += 1;
  if (input.isRetry) {
    sshCommandRetriesTotal += 1;
  }
}

export function recordSshCommandSuccess(): void {
  sshCommandSucceededTotal += 1;
  sshCommandLastSuccessAtMs = Date.now();
}

export function recordSshCommandFinalFailure(input: { timedOut: boolean }): void {
  const nowMs = Date.now();
  refreshFailureWindow(nowMs);

  sshCommandFinalFailuresTotal += 1;
  sshFailuresLastHour += 1;
  sshCommandLastFailureAtMs = nowMs;

  if (input.timedOut) {
    sshCommandTimeoutFailuresTotal += 1;
    sshTimeoutFailuresLastHour += 1;
  }
}

export function sshHealthStats(): {
  attemptsTotal: number;
  succeededTotal: number;
  retriesTotal: number;
  finalFailuresTotal: number;
  timeoutFailuresTotal: number;
  finalFailuresLastHour: number;
  timeoutFailuresLastHour: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  alerts: {
    finalFailuresLastHourHigh: boolean;
    timeoutFailuresLastHourHigh: boolean;
    requiresAttention: boolean;
    thresholds: {
      finalFailures1hHigh: number;
      timeoutFailures1hHigh: number;
    };
  };
} {
  const nowMs = Date.now();
  refreshFailureWindow(nowMs);

  const finalFailuresLastHourHigh = sshFailuresLastHour >= appConfig.SSH_ALERT_FINAL_FAILURES_1H_HIGH;
  const timeoutFailuresLastHourHigh = sshTimeoutFailuresLastHour >= appConfig.SSH_ALERT_TIMEOUT_FAILURES_1H_HIGH;

  return {
    attemptsTotal: sshCommandAttemptsTotal,
    succeededTotal: sshCommandSucceededTotal,
    retriesTotal: sshCommandRetriesTotal,
    finalFailuresTotal: sshCommandFinalFailuresTotal,
    timeoutFailuresTotal: sshCommandTimeoutFailuresTotal,
    finalFailuresLastHour: sshFailuresLastHour,
    timeoutFailuresLastHour: sshTimeoutFailuresLastHour,
    lastSuccessAt: sshCommandLastSuccessAtMs === null ? null : new Date(sshCommandLastSuccessAtMs).toISOString(),
    lastFailureAt: sshCommandLastFailureAtMs === null ? null : new Date(sshCommandLastFailureAtMs).toISOString(),
    alerts: {
      finalFailuresLastHourHigh,
      timeoutFailuresLastHourHigh,
      requiresAttention: finalFailuresLastHourHigh || timeoutFailuresLastHourHigh,
      thresholds: {
        finalFailures1hHigh: appConfig.SSH_ALERT_FINAL_FAILURES_1H_HIGH,
        timeoutFailures1hHigh: appConfig.SSH_ALERT_TIMEOUT_FAILURES_1H_HIGH
      }
    }
  };
}

export function sshPrometheusMetrics(): string {
  const s = sshHealthStats();

  const lines: string[] = [
    "# HELP ssh_commands_attempts_total Total SSH/scp command attempts",
    "# TYPE ssh_commands_attempts_total counter",
    `ssh_commands_attempts_total ${s.attemptsTotal}`,
    "",
    "# HELP ssh_commands_succeeded_total Total SSH/scp command attempts that succeeded",
    "# TYPE ssh_commands_succeeded_total counter",
    `ssh_commands_succeeded_total ${s.succeededTotal}`,
    "",
    "# HELP ssh_commands_retries_total Total SSH/scp retry attempts",
    "# TYPE ssh_commands_retries_total counter",
    `ssh_commands_retries_total ${s.retriesTotal}`,
    "",
    "# HELP ssh_commands_final_failures_total Total SSH/scp operations that failed after retries",
    "# TYPE ssh_commands_final_failures_total counter",
    `ssh_commands_final_failures_total ${s.finalFailuresTotal}`,
    "",
    "# HELP ssh_commands_timeout_failures_total Total SSH/scp operations that failed due to timeout",
    "# TYPE ssh_commands_timeout_failures_total counter",
    `ssh_commands_timeout_failures_total ${s.timeoutFailuresTotal}`,
    "",
    "# HELP ssh_commands_final_failures_1hour SSH/scp final failures in last hour",
    "# TYPE ssh_commands_final_failures_1hour gauge",
    `ssh_commands_final_failures_1hour ${s.finalFailuresLastHour}`,
    "",
    "# HELP ssh_commands_timeout_failures_1hour SSH/scp timeout failures in last hour",
    "# TYPE ssh_commands_timeout_failures_1hour gauge",
    `ssh_commands_timeout_failures_1hour ${s.timeoutFailuresLastHour}`,
    "",
    "# HELP ssh_alert_final_failures_1hour_high_flag Alert flag for high SSH final failures in last hour",
    "# TYPE ssh_alert_final_failures_1hour_high_flag gauge",
    `ssh_alert_final_failures_1hour_high_flag ${s.alerts.finalFailuresLastHourHigh ? 1 : 0}`,
    "",
    "# HELP ssh_alert_timeout_failures_1hour_high_flag Alert flag for high SSH timeout failures in last hour",
    "# TYPE ssh_alert_timeout_failures_1hour_high_flag gauge",
    `ssh_alert_timeout_failures_1hour_high_flag ${s.alerts.timeoutFailuresLastHourHigh ? 1 : 0}`,
    "",
    "# HELP ssh_alert_requires_attention_flag Aggregated SSH alert flag",
    "# TYPE ssh_alert_requires_attention_flag gauge",
    `ssh_alert_requires_attention_flag ${s.alerts.requiresAttention ? 1 : 0}`,
    ""
  ];

  return lines.join("\n");
}

export function __resetSshHealthForTests(): void {
  sshCommandAttemptsTotal = 0;
  sshCommandSucceededTotal = 0;
  sshCommandRetriesTotal = 0;
  sshCommandFinalFailuresTotal = 0;
  sshCommandTimeoutFailuresTotal = 0;
  sshCommandLastSuccessAtMs = null;
  sshCommandLastFailureAtMs = null;
  sshFailuresLastHour = 0;
  sshTimeoutFailuresLastHour = 0;
  sshFailureWindowStartMs = Date.now();
}
