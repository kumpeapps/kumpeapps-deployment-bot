/**
 * Health and metrics tracking for GitHub secret API reads.
 */

let githubSecretReadAttemptsTotal = 0;
let githubSecretReadSuccessesTotal = 0;
let githubSecretReadFailuresTotal = 0;
let githubSecretReadTimeoutsTotal = 0;
let githubSecretReadRetriesTotal = 0;
let githubSecretReadLastSuccessAtMs: number | null = null;
let githubSecretReadLastFailureAtMs: number | null = null;
let githubSecretReadFailuresLastHour = 0;
let githubSecretReadFailuresWindowStartMs = Date.now();

function refreshFailureWindow(nowMs: number): void {
  const windowMs = 60 * 60 * 1000;
  if (nowMs - githubSecretReadFailuresWindowStartMs >= windowMs) {
    githubSecretReadFailuresWindowStartMs = nowMs;
    githubSecretReadFailuresLastHour = 0;
  }
}

export function recordGithubSecretReadAttempt(input: { isRetry: boolean }): void {
  githubSecretReadAttemptsTotal += 1;
  if (input.isRetry) {
    githubSecretReadRetriesTotal += 1;
  }
}

export function recordGithubSecretReadSuccess(): void {
  githubSecretReadSuccessesTotal += 1;
  githubSecretReadLastSuccessAtMs = Date.now();
}

export function recordGithubSecretReadFailure(input: { timedOut: boolean }): void {
  githubSecretReadFailuresTotal += 1;
  githubSecretReadLastFailureAtMs = Date.now();
  if (input.timedOut) {
    githubSecretReadTimeoutsTotal += 1;
  }
  refreshFailureWindow(githubSecretReadLastFailureAtMs);
  githubSecretReadFailuresLastHour += 1;
}

export function getGithubSecretReadHealth() {
  return {
    attemptsTotal: githubSecretReadAttemptsTotal,
    successesTotal: githubSecretReadSuccessesTotal,
    failuresTotal: githubSecretReadFailuresTotal,
    timeoutsTotal: githubSecretReadTimeoutsTotal,
    retriesTotal: githubSecretReadRetriesTotal,
    failuresLastHour: githubSecretReadFailuresLastHour,
    lastSuccessAtMs: githubSecretReadLastSuccessAtMs,
    lastFailureAtMs: githubSecretReadLastFailureAtMs
  };
}
