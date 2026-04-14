/**
 * GitHub Deployment API integration.
 *
 * Creates a GitHub Deployment object at the start of a run and posts
 * DeploymentStatus updates (in_progress → success | failure) at the end.
 *
 * Auth: uses GITHUB_API_TOKEN (PAT or App installation token).
 * When GITHUB_DEPLOYMENTS_ENABLED=false all calls are no-ops.
 */

import { appConfig } from "../config.js";
import { getGitHubToken } from "./github-app-auth.js";

type GithubDeploymentCreateResponse = {
  id?: number;
};

type GithubDeploymentStatusState =
  | "in_progress"
  | "queued"
  | "success"
  | "failure"
  | "error"
  | "inactive";

type GithubWorkflowRun = {
  id: number;
  name: string;
  status: string; // "queued" | "in_progress" | "completed"
  conclusion: string | null; // "success" | "failure" | "cancelled" | "skipped" | null
};

type GithubWorkflowRunsResponse = {
  total_count: number;
  workflow_runs: GithubWorkflowRun[];
};

type GithubCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
};

type GithubCheckRunsResponse = {
  total_count: number;
  check_runs: GithubCheckRun[];
};

type GithubIssue = {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
};

type GithubIssuesSearchResponse = {
  total_count: number;
  items: GithubIssue[];
};

type GithubIssueCreateResponse = {
  id: number;
  number: number;
  html_url: string;
};

let githubApiConsecutiveFailures = 0;
let githubApiCircuitOpenedAtMs: number | null = null;
let githubApiPostsTotal = 0;
let githubApiPostsSucceededTotal = 0;
let githubApiFinalFailuresTotal = 0;
let githubApiCircuitOpenSkipsTotal = 0;
let githubApiTransientRetriesTotal = 0;
let githubApiLastSuccessAtMs: number | null = null;
let githubApiLastFailureAtMs: number | null = null;
let githubApiFinalFailuresLastHour = 0;
let githubApiFinalFailuresWindowStartMs = Date.now();

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function refreshFailureWindow(nowMs: number): void {
  const windowMs = 60 * 60 * 1000;
  if (nowMs - githubApiFinalFailuresWindowStartMs >= windowMs) {
    githubApiFinalFailuresWindowStartMs = nowMs;
    githubApiFinalFailuresLastHour = 0;
  }
}

function isCircuitOpen(nowMs: number): boolean {
  if (githubApiCircuitOpenedAtMs === null) {
    return false;
  }

  const cooldownMs = appConfig.GITHUB_API_CIRCUIT_BREAKER_COOLDOWN_MS;
  if (nowMs - githubApiCircuitOpenedAtMs >= cooldownMs) {
    githubApiCircuitOpenedAtMs = null;
    githubApiConsecutiveFailures = 0;
    return false;
  }

  return true;
}

function markFailureAndMaybeOpenCircuit(): void {
  githubApiConsecutiveFailures += 1;
  githubApiFinalFailuresTotal += 1;
  githubApiLastFailureAtMs = Date.now();
  refreshFailureWindow(githubApiLastFailureAtMs);
  githubApiFinalFailuresLastHour += 1;
  if (githubApiConsecutiveFailures >= appConfig.GITHUB_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    githubApiCircuitOpenedAtMs = Date.now();
  }
}

function markSuccess(): void {
  githubApiConsecutiveFailures = 0;
  githubApiCircuitOpenedAtMs = null;
  githubApiPostsSucceededTotal += 1;
  githubApiLastSuccessAtMs = Date.now();
}

export function __resetGithubApiCircuitBreakerForTests(): void {
  githubApiConsecutiveFailures = 0;
  githubApiCircuitOpenedAtMs = null;
  githubApiPostsTotal = 0;
  githubApiPostsSucceededTotal = 0;
  githubApiFinalFailuresTotal = 0;
  githubApiCircuitOpenSkipsTotal = 0;
  githubApiTransientRetriesTotal = 0;
  githubApiLastSuccessAtMs = null;
  githubApiLastFailureAtMs = null;
  githubApiFinalFailuresLastHour = 0;
  githubApiFinalFailuresWindowStartMs = Date.now();
}

export function githubApiHealthStats(): {
  postsTotal: number;
  postsSucceededTotal: number;
  finalFailuresTotal: number;
  finalFailuresLastHour: number;
  transientRetriesTotal: number;
  circuitOpenSkipsTotal: number;
  consecutiveFailures: number;
  circuitOpen: boolean;
  circuitOpenedAt: string | null;
  cooldownRemainingMs: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  alerts: {
    finalFailuresLastHourHigh: boolean;
    circuitOpen: boolean;
    requiresAttention: boolean;
    thresholds: {
      finalFailures1hHigh: number;
      circuitBreakerFailureThreshold: number;
    };
  };
} {
  const nowMs = Date.now();
  refreshFailureWindow(nowMs);
  const circuitOpen = isCircuitOpen(nowMs);
  const cooldownMs = appConfig.GITHUB_API_CIRCUIT_BREAKER_COOLDOWN_MS;
  const cooldownRemainingMs =
    githubApiCircuitOpenedAtMs === null ? 0 : Math.max(0, cooldownMs - (nowMs - githubApiCircuitOpenedAtMs));
  const finalFailuresLastHourHigh =
    githubApiFinalFailuresLastHour >= appConfig.GITHUB_API_ALERT_FINAL_FAILURES_1H_HIGH;

  return {
    postsTotal: githubApiPostsTotal,
    postsSucceededTotal: githubApiPostsSucceededTotal,
    finalFailuresTotal: githubApiFinalFailuresTotal,
    finalFailuresLastHour: githubApiFinalFailuresLastHour,
    transientRetriesTotal: githubApiTransientRetriesTotal,
    circuitOpenSkipsTotal: githubApiCircuitOpenSkipsTotal,
    consecutiveFailures: githubApiConsecutiveFailures,
    circuitOpen,
    circuitOpenedAt: githubApiCircuitOpenedAtMs === null ? null : new Date(githubApiCircuitOpenedAtMs).toISOString(),
    cooldownRemainingMs,
    lastSuccessAt: githubApiLastSuccessAtMs === null ? null : new Date(githubApiLastSuccessAtMs).toISOString(),
    lastFailureAt: githubApiLastFailureAtMs === null ? null : new Date(githubApiLastFailureAtMs).toISOString(),
    alerts: {
      finalFailuresLastHourHigh,
      circuitOpen,
      requiresAttention: finalFailuresLastHourHigh || circuitOpen,
      thresholds: {
        finalFailures1hHigh: appConfig.GITHUB_API_ALERT_FINAL_FAILURES_1H_HIGH,
        circuitBreakerFailureThreshold: appConfig.GITHUB_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD
      }
    }
  };
}

export function githubApiPrometheusMetrics(): string {
  const s = githubApiHealthStats();

  const lines: string[] = [
    "# HELP github_api_posts_total Total GitHub API POST operations attempted",
    "# TYPE github_api_posts_total counter",
    `github_api_posts_total ${s.postsTotal}`,
    "",
    "# HELP github_api_posts_succeeded_total Total GitHub API POST operations succeeded",
    "# TYPE github_api_posts_succeeded_total counter",
    `github_api_posts_succeeded_total ${s.postsSucceededTotal}`,
    "",
    "# HELP github_api_final_failures_total Total GitHub API POST operations that failed after retries",
    "# TYPE github_api_final_failures_total counter",
    `github_api_final_failures_total ${s.finalFailuresTotal}`,
    "",
    "# HELP github_api_final_failures_1hour Final GitHub API POST failures in last hour window",
    "# TYPE github_api_final_failures_1hour gauge",
    `github_api_final_failures_1hour ${s.finalFailuresLastHour}`,
    "",
    "# HELP github_api_transient_retries_total Total transient retries attempted for GitHub API POST operations",
    "# TYPE github_api_transient_retries_total counter",
    `github_api_transient_retries_total ${s.transientRetriesTotal}`,
    "",
    "# HELP github_api_circuit_open_skips_total Total GitHub API POST operations skipped due to open circuit",
    "# TYPE github_api_circuit_open_skips_total counter",
    `github_api_circuit_open_skips_total ${s.circuitOpenSkipsTotal}`,
    "",
    "# HELP github_api_circuit_open_flag Circuit breaker open flag for GitHub API",
    "# TYPE github_api_circuit_open_flag gauge",
    `github_api_circuit_open_flag ${s.circuitOpen ? 1 : 0}`,
    "",
    "# HELP github_api_alert_final_failures_1hour_high_flag Alert flag for high GitHub API final failures in last hour",
    "# TYPE github_api_alert_final_failures_1hour_high_flag gauge",
    `github_api_alert_final_failures_1hour_high_flag ${s.alerts.finalFailuresLastHourHigh ? 1 : 0}`,
    "",
    "# HELP github_api_alert_requires_attention_flag Aggregated GitHub API alert flag",
    "# TYPE github_api_alert_requires_attention_flag gauge",
    `github_api_alert_requires_attention_flag ${s.alerts.requiresAttention ? 1 : 0}`,
    ""
  ];

  return lines.join("\n");
}

async function authHeaders(repositoryOwner: string, repositoryName: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "kumpeapps-deployment-bot",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  const token = await getGitHubToken(repositoryOwner, repositoryName);
  if (token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function githubPost<T>(path: string, body: unknown, repositoryOwner: string, repositoryName: string): Promise<T | null> {
  const nowMs = Date.now();
  if (isCircuitOpen(nowMs)) {
    githubApiCircuitOpenSkipsTotal += 1;
    console.warn(`GitHub API circuit open; skipping POST ${path}`);
    return null;
  }

  const maxRetries = appConfig.GITHUB_API_POST_MAX_RETRIES;
  const baseDelayMs = appConfig.GITHUB_API_POST_RETRY_BASE_DELAY_MS;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      githubApiPostsTotal += 1;
      const response = await fetch(`https://api.github.com${path}`, {
        method: "POST",
        headers: {
          ...(await authHeaders(repositoryOwner, repositoryName)),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        markSuccess();
        return (await response.json()) as T;
      }

      const text = await response.text().catch(() => "");
      const shouldRetry = attempt < maxRetries && isTransientStatus(response.status);
      if (shouldRetry) {
        githubApiTransientRetriesTotal += 1;
        await sleep(baseDelayMs * Math.pow(2, attempt));
        continue;
      }

      console.warn(`GitHub API POST ${path} failed (${response.status}): ${text.slice(0, 200)}`);
      markFailureAndMaybeOpenCircuit();
      return null;
    }

    markFailureAndMaybeOpenCircuit();
    return null;
  } catch (err) {
    console.warn(`GitHub API POST ${path} threw: ${err instanceof Error ? err.message : String(err)}`);
    markFailureAndMaybeOpenCircuit();
    return null;
  }
}

/**
 * Makes a PATCH request to GitHub API with retry logic and circuit breaker.
 */
async function githubPatch<T>(path: string, body: unknown, repositoryOwner: string, repositoryName: string): Promise<T | null> {
  const nowMs = Date.now();
  if (isCircuitOpen(nowMs)) {
    githubApiCircuitOpenSkipsTotal += 1;
    console.warn(`GitHub API circuit open; skipping PATCH ${path}`);
    return null;
  }

  const maxRetries = appConfig.GITHUB_API_POST_MAX_RETRIES;
  const baseDelayMs = appConfig.GITHUB_API_POST_RETRY_BASE_DELAY_MS;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      githubApiPostsTotal += 1;
      const response = await fetch(`https://api.github.com${path}`, {
        method: "PATCH",
        headers: {
          ...(await authHeaders(repositoryOwner, repositoryName)),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        markSuccess();
        return (await response.json()) as T;
      }

      const text = await response.text().catch(() => "");
      const shouldRetry = attempt < maxRetries && isTransientStatus(response.status);
      if (shouldRetry) {
        githubApiTransientRetriesTotal += 1;
        await sleep(baseDelayMs * Math.pow(2, attempt));
        continue;
      }

      console.warn(`GitHub API PATCH ${path} failed (${response.status}): ${text.slice(0, 200)}`);
      markFailureAndMaybeOpenCircuit();
      return null;
    }

    markFailureAndMaybeOpenCircuit();
    return null;
  } catch (err) {
    console.warn(`GitHub API PATCH ${path} threw: ${err instanceof Error ? err.message : String(err)}`);
    markFailureAndMaybeOpenCircuit();
    return null;
  }
}

/**
 * Creates a GitHub Deployment for the given commit + environment.
 * Returns the GitHub Deployment ID or null when disabled / on error.
 */
export async function createGithubDeployment(input: {
  repositoryOwner: string;
  repositoryName: string;
  sha: string;
  environment: string;
  description?: string;
}): Promise<bigint | null> {
  if (!appConfig.GITHUB_DEPLOYMENTS_ENABLED) {
    return null;
  }

  const path = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/deployments`;

  const data = await githubPost<GithubDeploymentCreateResponse>(path, {
    ref: input.sha,
    environment: input.environment,
    description: input.description ?? `kumpeapps-deployment-bot: ${input.environment}`,
    auto_merge: false,
    required_contexts: []
  }, input.repositoryOwner, input.repositoryName);

  if (data?.id !== undefined && data.id !== null) {
    return BigInt(data.id);
  }

  return null;
}

/**
 * Posts a DeploymentStatus update to an existing GitHub Deployment.
 * Silently no-ops when disabled or githubDeploymentId is null.
 */
export async function updateGithubDeploymentStatus(input: {
  repositoryOwner: string;
  repositoryName: string;
  githubDeploymentId: bigint;
  state: GithubDeploymentStatusState;
  logUrl?: string;
  description?: string;
}): Promise<void> {
  if (!appConfig.GITHUB_DEPLOYMENTS_ENABLED) {
    return;
  }

  const path = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/deployments/${input.githubDeploymentId}/statuses`;

  await githubPost(path, {
    state: input.state,
    log_url: input.logUrl,
    description: input.description
  }, input.repositoryOwner, input.repositoryName);
}

/**
 * Deployment status check state shown on commits/PRs.
 * Supports in_progress through Check Runs.
 */
type GithubStatusCheckState =
  | "pending"
  | "in_progress"
  | "success"
  | "failure"
  | "error";

/**
 * Creates or updates a commit status check on a commit.
 * This shows up as a status check on PRs and commits.
 * Silently no-ops when commit status checks are disabled.
 */
export async function updateCommitStatus(input: {
  repositoryOwner: string;
  repositoryName: string;
  commitSha: string;
  state: GithubStatusCheckState;
  context: string;
  description?: string;
  targetUrl?: string;
}): Promise<void> {
  if (!appConfig.GITHUB_COMMIT_STATUS_ENABLED) {
    return;
  }

  const description = input.description?.slice(0, 140);

  // Prefer Check Runs so GitHub can display real in-progress state.
  const checkRunListPath = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/commits/${input.commitSha}/check-runs`;
  const checkRunCreatePath = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/check-runs`;
  const existingRuns = await githubGet<GithubCheckRunsResponse>(
    checkRunListPath,
    input.repositoryOwner,
    input.repositoryName
  );

  if (existingRuns) {
    const matchingRuns = existingRuns.check_runs
      .filter((run) => run.name === input.context)
      .sort((a, b) => b.id - a.id);
    const existingRun = matchingRuns[0];

    if (input.state === "pending" || input.state === "in_progress") {
      const status = input.state === "in_progress" ? "in_progress" : "queued";

      if (existingRun) {
        const updatePath = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/check-runs/${existingRun.id}`;
        const updated = await githubPatch(updatePath, {
          name: input.context,
          status,
          details_url: input.targetUrl,
          output: {
            title: input.context,
            summary: description ?? `Deployment ${input.state.replace("_", " ")}`
          }
        }, input.repositoryOwner, input.repositoryName);

        if (updated) {
          return;
        }
      } else {
        const created = await githubPost(checkRunCreatePath, {
          name: input.context,
          head_sha: input.commitSha,
          status,
          details_url: input.targetUrl,
          output: {
            title: input.context,
            summary: description ?? `Deployment ${input.state.replace("_", " ")}`
          }
        }, input.repositoryOwner, input.repositoryName);

        if (created) {
          return;
        }
      }
    } else {
      const conclusion = input.state === "success" ? "success" : "failure";
      const now = new Date().toISOString();

      if (existingRun) {
        const updatePath = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/check-runs/${existingRun.id}`;
        const updated = await githubPatch(updatePath, {
          name: input.context,
          status: "completed",
          conclusion,
          completed_at: now,
          details_url: input.targetUrl,
          output: {
            title: input.context,
            summary: description ?? "Deployment completed"
          }
        }, input.repositoryOwner, input.repositoryName);

        if (updated) {
          return;
        }
      } else {
        const created = await githubPost(checkRunCreatePath, {
          name: input.context,
          head_sha: input.commitSha,
          status: "completed",
          conclusion,
          completed_at: now,
          details_url: input.targetUrl,
          output: {
            title: input.context,
            summary: description ?? "Deployment completed"
          }
        }, input.repositoryOwner, input.repositoryName);

        if (created) {
          return;
        }
      }
    }
  }

  // Fallback to traditional commit statuses if Check Runs are unavailable.
  const fallbackState = input.state === "in_progress" ? "pending" : input.state;

  const path = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/statuses/${input.commitSha}`;

  await githubPost(path, {
    state: fallbackState,
    context: input.context,
    description, // GitHub limit is 140 chars
    target_url: input.targetUrl
  }, input.repositoryOwner, input.repositoryName);
}

/**
 * Makes a GET request to GitHub API with retry logic and circuit breaker.
 */
async function githubGet<T>(path: string, repositoryOwner: string, repositoryName: string): Promise<T | null> {
  const nowMs = Date.now();
  if (isCircuitOpen(nowMs)) {
    githubApiCircuitOpenSkipsTotal += 1;
    console.warn(`GitHub API circuit open; skipping GET ${path}`);
    return null;
  }

  const maxRetries = appConfig.GITHUB_API_POST_MAX_RETRIES;
  const baseDelayMs = appConfig.GITHUB_API_POST_RETRY_BASE_DELAY_MS;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      githubApiPostsTotal += 1;
      const response = await fetch(`https://api.github.com${path}`, {
        method: "GET",
        headers: await authHeaders(repositoryOwner, repositoryName)
      });

      if (response.ok) {
        markSuccess();
        return (await response.json()) as T;
      }

      const text = await response.text().catch(() => "");
      const shouldRetry = attempt < maxRetries && isTransientStatus(response.status);
      if (shouldRetry) {
        githubApiTransientRetriesTotal += 1;
        await sleep(baseDelayMs * Math.pow(2, attempt));
        continue;
      }

      console.warn(`GitHub API GET ${path} failed (${response.status}): ${text.slice(0, 200)}`);
      markFailureAndMaybeOpenCircuit();
      return null;
    }

    markFailureAndMaybeOpenCircuit();
    return null;
  } catch (err) {
    console.warn(`GitHub API GET ${path} threw: ${err instanceof Error ? err.message : String(err)}`);
    markFailureAndMaybeOpenCircuit();
    return null;
  }
}

/**
 * Waits for all GitHub Actions workflows for a commit to complete.
 * Returns when all workflows are complete (success, failure, or skipped).
 * Throws if workflows fail or timeout is reached.
 */
export async function waitForWorkflowsToComplete(input: {
  repositoryOwner: string;
  repositoryName: string;
  commitSha: string;
}): Promise<{ totalRuns: number; successful: number; failed: number }> {
  if (!appConfig.GITHUB_WORKFLOW_CHECK_ENABLED) {
    console.log("[GitHub Workflows] Workflow checking disabled, skipping");
    return { totalRuns: 0, successful: 0, failed: 0 };
  }

  const path = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/commits/${input.commitSha}/check-runs`;
  const startTime = Date.now();
  const timeoutMs = appConfig.GITHUB_WORKFLOW_CHECK_TIMEOUT_MS;
  const pollIntervalMs = appConfig.GITHUB_WORKFLOW_CHECK_POLL_INTERVAL_MS;

  console.log(`[GitHub Workflows] Checking workflows for commit ${input.commitSha.slice(0, 7)}`);

  while (Date.now() - startTime < timeoutMs) {
    const data = await githubGet<{ total_count: number; check_runs: Array<{ id: number; name: string; status: string; conclusion: string | null }> }>(
      path,
      input.repositoryOwner,
      input.repositoryName
    );

    if (!data) {
      throw new Error("Failed to fetch workflow runs from GitHub API");
    }

    const totalRuns = data.total_count;

    if (totalRuns === 0) {
      console.log(`[GitHub Workflows] No workflows found for commit ${input.commitSha.slice(0, 7)}, proceeding`);
      return { totalRuns: 0, successful: 0, failed: 0 };
    }

    const checkRuns = data.check_runs;
    const inProgress = checkRuns.filter(run => run.status !== "completed");
    const completed = checkRuns.filter(run => run.status === "completed");
    const successful = completed.filter(run => run.conclusion === "success" || run.conclusion === "skipped");
    const failed = completed.filter(run => run.conclusion === "failure" || run.conclusion === "cancelled");

    console.log(
      `[GitHub Workflows] Status: ${completed.length}/${totalRuns} complete ` +
      `(${successful.length} success, ${failed.length} failed, ${inProgress.length} in progress)`
    );

    if (inProgress.length > 0) {
      const inProgressNames = inProgress.map(run => run.name).join(", ");
      console.log(`[GitHub Workflows] Waiting for: ${inProgressNames}`);
    }

    if (completed.length === totalRuns) {
      if (failed.length > 0) {
        const failedNames = failed.map(run => run.name).join(", ");
        throw new Error(`Workflow checks failed: ${failedNames}`);
      }

      console.log(`[GitHub Workflows] All ${totalRuns} workflow(s) completed successfully`);
      return { totalRuns, successful: successful.length, failed: 0 };
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timeout waiting for workflows to complete after ${timeoutMs}ms`);
}

/**
 * Search for existing deployment error issue for a repository/environment.
 * Returns the issue number if found, null otherwise.
 */
export async function findDeploymentErrorIssue(input: {
  repositoryOwner: string;
  repositoryName: string;
  environment: string;
}): Promise<number | null> {
  // Search for open issues with deployment bot marker in title
  const searchQuery = `repo:${input.repositoryOwner}/${input.repositoryName} is:issue is:open "[Deployment Bot] ${input.environment}" in:title`;
  const path = `/search/issues?q=${encodeURIComponent(searchQuery)}`;

  const data = await githubGet<GithubIssuesSearchResponse>(
    path,
    input.repositoryOwner,
    input.repositoryName
  );

  if (!data || data.total_count === 0) {
    return null;
  }

  // Return the first matching issue
  return data.items[0]?.number || null;
}

/**
 * Create a new deployment error issue.
 * Returns the issue number if created, null on error.
 */
export async function createDeploymentErrorIssue(input: {
  repositoryOwner: string;
  repositoryName: string;
  environment: string;
  commitSha: string;
  errorMessage: string;
  deploymentId: number;
  logUrl?: string;
}): Promise<number | null> {
  const path = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues`;

  const title = `[Deployment Bot] ${input.environment} deployment failed`;
  const hints = `<details>\n<summary>💡 Available commands for collaborators</summary>\n\n` +
    `Repository collaborators can use these commands in issue comments:\n\n` +
    `- \`/redeploy\` - Redeploy the latest commit on the default branch\n` +
    `- \`/redeploy-dev\` - Redeploy to dev environment only\n` +
    `- \`/redeploy-stage\` - Redeploy to stage environment only\n` +
    `- \`/redeploy-prod\` - Redeploy to prod environment only\n\n` +
    `</details>`;
  
  const body = `## Deployment Failed\n\n` +
    `**Environment:** ${input.environment}\n` +
    `**Commit:** ${input.commitSha.slice(0, 7)}\n` +
    `**Deployment ID:** ${input.deploymentId}\n` +
    (input.logUrl ? `**Logs:** ${input.logUrl}\n` : '') +
    `\n### Error\n\n\`\`\`\n${input.errorMessage}\n\`\`\`\n\n` +
    `${hints}\n\n` +
    `---\n*This issue was automatically created by the deployment bot.*`;

  const data = await githubPost<GithubIssueCreateResponse>(
    path,
    {
      title,
      body,
      labels: ["bug", "deployment"]
    },
    input.repositoryOwner,
    input.repositoryName
  );

  if (!data) {
    return null;
  }

  console.log(`[GitHub Issues] Created deployment error issue #${data.number}: ${data.html_url}`);
  return data.number;
}

/**
 * Add a comment to an existing deployment error issue.
 */
export async function addDeploymentErrorComment(input: {
  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
  commitSha: string;
  errorMessage: string;
  deploymentId: number;
  logUrl?: string;
}): Promise<void> {
  const path = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues/${input.issueNumber}/comments`;

  const hints = `<details>\n<summary>💡 Available commands</summary>\n\n` +
    `- \`/redeploy\` - Redeploy latest commit\n` +
    `- \`/redeploy-dev\`, \`/redeploy-stage\`, \`/redeploy-prod\` - Redeploy to specific environment\n\n` +
    `</details>`;
  
  const body = `## Another Deployment Failed\n\n` +
    `**Commit:** ${input.commitSha.slice(0, 7)}\n` +
    `**Deployment ID:** ${input.deploymentId}\n` +
    (input.logUrl ? `**Logs:** ${input.logUrl}\n` : '') +
    `\n### Error\n\n\`\`\`\n${input.errorMessage}\n\`\`\`\n\n` +
    `${hints}`;

  await githubPost(
    path,
    { body },
    input.repositoryOwner,
    input.repositoryName
  );

  console.log(`[GitHub Issues] Added comment to deployment error issue #${input.issueNumber}`);
}

/**
 * Report deployment error by creating an issue or commenting on existing one.
 * This is a best-effort operation - failures are logged but not thrown.
 */
export async function reportDeploymentError(input: {
  repositoryOwner: string;
  repositoryName: string;
  environment: string;
  commitSha: string;
  errorMessage: string;
  deploymentId: number;
  logUrl?: string;
}): Promise<void> {
  try {
    // Check if there's already an open deployment error issue
    const existingIssue = await findDeploymentErrorIssue({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      environment: input.environment
    });

    if (existingIssue) {
      // Add comment to existing issue
      await addDeploymentErrorComment({
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        issueNumber: existingIssue,
        commitSha: input.commitSha,
        errorMessage: input.errorMessage,
        deploymentId: input.deploymentId,
        logUrl: input.logUrl
      });
    } else {
      // Create new issue
      await createDeploymentErrorIssue(input);
    }
  } catch (error) {
    console.error(`[GitHub Issues] Failed to report deployment error:`, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Close a deployment error issue when deployment succeeds.
 * This is a best-effort operation - failures are logged but not thrown.
 */
export async function closeDeploymentErrorIssue(input: {
  repositoryOwner: string;
  repositoryName: string;
  environment: string;
  commitSha: string;
  deploymentId: number;
  logUrl?: string;
}): Promise<void> {
  if (!appConfig.GITHUB_DEPLOYMENT_ERROR_ISSUES_ENABLED) {
    return;
  }

  try {
    // Find the open deployment error issue for this environment
    const issueNumber = await findDeploymentErrorIssue({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      environment: input.environment
    });

    if (!issueNumber) {
      // No open issue to close
      return;
    }

    // Add a success comment before closing
    const path = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues/${issueNumber}/comments`;
    const commentBody = `## ✅ Deployment Succeeded\n\n` +
      `**Commit:** ${input.commitSha.slice(0, 7)}\n` +
      `**Deployment ID:** ${input.deploymentId}\n` +
      (input.logUrl ? `**Logs:** ${input.logUrl}\n` : '') +
      `\n---\n*Automatically closing this issue as the deployment has succeeded.*`;

    await githubPost(
      path,
      { body: commentBody },
      input.repositoryOwner,
      input.repositoryName
    );

    // Close the issue
    const closePath = `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues/${issueNumber}`;
    await githubPatch(
      closePath,
      { state: "closed" },
      input.repositoryOwner,
      input.repositoryName
    );

    console.log(`[GitHub Issues] Closed deployment error issue #${issueNumber} for ${input.environment} environment`);
  } catch (error) {
    console.error(`[GitHub Issues] Failed to close deployment error issue:`, error instanceof Error ? error.message : String(error));
  }
}
