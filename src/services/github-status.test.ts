import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { appConfig } from "../config.js";
import {
  __resetGithubApiCircuitBreakerForTests,
  createGithubDeployment,
  githubApiHealthStats,
  githubApiPrometheusMetrics,
  updateGithubDeploymentStatus,
  updateCommitStatus,
  waitForWorkflowsToComplete
} from "./github-status.js";

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const originalFetch = globalThis.fetch;

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  appConfig.GITHUB_DEPLOYMENTS_ENABLED = false;
  appConfig.GITHUB_COMMIT_STATUS_ENABLED = true;
  appConfig.GITHUB_API_TOKEN = "";
  appConfig.GITHUB_API_POST_MAX_RETRIES = 2;
  appConfig.GITHUB_API_POST_RETRY_BASE_DELAY_MS = 1;
  appConfig.GITHUB_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
  appConfig.GITHUB_API_CIRCUIT_BREAKER_COOLDOWN_MS = 50;
  appConfig.GITHUB_API_ALERT_FINAL_FAILURES_1H_HIGH = 3;
  __resetGithubApiCircuitBreakerForTests();
});

describe("createGithubDeployment", () => {
  it("returns null and does not call fetch when deployments are disabled", async () => {
    appConfig.GITHUB_DEPLOYMENTS_ENABLED = false;

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return makeJsonResponse(200, { id: 123 });
    }) as typeof fetch;

    const result = await createGithubDeployment({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      sha: "abc123",
      environment: "dev"
    });

    assert.equal(result, null);
    assert.equal(called, false);
  });

  it("posts to GitHub and returns deployment id when enabled", async () => {
    appConfig.GITHUB_DEPLOYMENTS_ENABLED = true;
    appConfig.GITHUB_API_TOKEN = "token-123";

    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return makeJsonResponse(201, { id: 987654 });
    }) as typeof fetch;

    const result = await createGithubDeployment({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      sha: "deadbeef",
      environment: "prod",
      description: "test deploy"
    });

    assert.equal(result, BigInt(987654));
    assert.equal(calls.length, 1);

    const url = String(calls[0].input);
    assert.ok(url.includes("/repos/kumpeapps/repo/deployments"));

    const body = JSON.parse(String(calls[0].init?.body ?? "{}")) as {
      ref?: string;
      environment?: string;
    };
    assert.equal(body.ref, "deadbeef");
    assert.equal(body.environment, "prod");
  });

  it("returns null on non-OK response", async () => {
    appConfig.GITHUB_DEPLOYMENTS_ENABLED = true;

    globalThis.fetch = (async () => makeJsonResponse(500, { message: "boom" })) as typeof fetch;

    const result = await createGithubDeployment({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      sha: "deadbeef",
      environment: "prod"
    });

    assert.equal(result, null);
  });

  it("retries transient failures and eventually succeeds", async () => {
    appConfig.GITHUB_DEPLOYMENTS_ENABLED = true;
    appConfig.GITHUB_API_POST_MAX_RETRIES = 2;

    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts < 3) {
        return makeJsonResponse(500, { message: "temporary" });
      }
      return makeJsonResponse(201, { id: 456 });
    }) as typeof fetch;

    const result = await createGithubDeployment({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      sha: "deadbeef",
      environment: "prod"
    });

    assert.equal(result, BigInt(456));
    assert.equal(attempts, 3);
  });
});

describe("updateGithubDeploymentStatus", () => {
  it("does not call fetch when disabled", async () => {
    appConfig.GITHUB_DEPLOYMENTS_ENABLED = false;

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return makeJsonResponse(201, {});
    }) as typeof fetch;

    await updateGithubDeploymentStatus({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      githubDeploymentId: BigInt(1),
      state: "in_progress"
    });

    assert.equal(called, false);
  });

  it("posts status update when enabled", async () => {
    appConfig.GITHUB_DEPLOYMENTS_ENABLED = true;

    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return makeJsonResponse(201, { id: 111 });
    }) as typeof fetch;

    await updateGithubDeploymentStatus({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      githubDeploymentId: BigInt(42),
      state: "success",
      logUrl: "https://deploy-bot.example.com/api/deployments/42",
      description: "all good"
    });

    assert.equal(calls.length, 1);
    const url = String(calls[0].input);
    assert.ok(url.includes("/repos/kumpeapps/repo/deployments/42/statuses"));

    const body = JSON.parse(String(calls[0].init?.body ?? "{}")) as {
      state?: string;
      description?: string;
      log_url?: string;
    };
    assert.equal(body.state, "success");
    assert.equal(body.description, "all good");
    assert.equal(body.log_url, "https://deploy-bot.example.com/api/deployments/42");
  });
});

describe("updateCommitStatus", () => {
  it("does not call fetch when disabled", async () => {
    appConfig.GITHUB_COMMIT_STATUS_ENABLED = false;

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return makeJsonResponse(201, {});
    }) as typeof fetch;

    await updateCommitStatus({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      commitSha: "abc123",
      state: "pending",
      context: "kumpeapps-bot/deployment/dev"
    });

    assert.equal(called, false);
  });

  it("posts check run when enabled", async () => {
    appConfig.GITHUB_COMMIT_STATUS_ENABLED = true;

    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const method = String(init?.method ?? "GET").toUpperCase();
      const url = String(input);

      if (method === "GET" && url.includes("/commits/deadbeef123/check-runs")) {
        return makeJsonResponse(200, { total_count: 0, check_runs: [] });
      }

      if (method === "POST" && url.includes("/repos/kumpeapps/repo/check-runs")) {
        return makeJsonResponse(201, { id: 789 });
      }

      return makeJsonResponse(404, { message: "unexpected request" });
    }) as typeof fetch;

    await updateCommitStatus({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      commitSha: "deadbeef123",
      state: "success",
      context: "kumpeapps-bot/deployment/prod",
      description: "Deployed successfully to prod",
      targetUrl: "https://bot.example.com/api/deployments/42"
    });

    assert.equal(calls.length, 2);
    const url = String(calls[1].input);
    assert.ok(url.includes("/repos/kumpeapps/repo/check-runs"));

    const body = JSON.parse(String(calls[1].init?.body ?? "{}")) as {
      name?: string;
      status?: string;
      conclusion?: string;
      details_url?: string;
      output?: {
        summary?: string;
      };
    };
    assert.equal(body.name, "kumpeapps-bot/deployment/prod");
    assert.equal(body.status, "completed");
    assert.equal(body.conclusion, "success");
    assert.equal(body.output?.summary, "Deployed successfully to prod");
    assert.equal(body.details_url, "https://bot.example.com/api/deployments/42");
  });

  it("supports in_progress status checks", async () => {
    appConfig.GITHUB_COMMIT_STATUS_ENABLED = true;

    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const method = String(init?.method ?? "GET").toUpperCase();
      const url = String(input);

      if (method === "GET" && url.includes("/commits/abc123/check-runs")) {
        return makeJsonResponse(200, { total_count: 0, check_runs: [] });
      }

      if (method === "POST" && url.includes("/repos/kumpeapps/repo/check-runs")) {
        return makeJsonResponse(201, { id: 456 });
      }

      return makeJsonResponse(404, { message: "unexpected request" });
    }) as typeof fetch;

    await updateCommitStatus({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      commitSha: "abc123",
      state: "in_progress",
      context: "kumpeapps-bot/deployment/dev",
      description: "Building VM"
    });

    const body = JSON.parse(String(calls[1].init?.body ?? "{}")) as {
      status?: string;
    };
    assert.equal(body.status, "in_progress");
  });

  it("creates a new check run when latest matching run is completed", async () => {
    appConfig.GITHUB_COMMIT_STATUS_ENABLED = true;

    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const method = String(init?.method ?? "GET").toUpperCase();
      const url = String(input);

      if (method === "GET" && url.includes("/commits/abc123/check-runs")) {
        return makeJsonResponse(200, {
          total_count: 1,
          check_runs: [
            {
              id: 321,
              name: "kumpeapps-bot/deployment/dev",
              status: "completed",
              conclusion: "failure"
            }
          ]
        });
      }

      if (method === "POST" && url.includes("/repos/kumpeapps/repo/check-runs")) {
        return makeJsonResponse(201, { id: 654 });
      }

      return makeJsonResponse(404, { message: "unexpected request" });
    }) as typeof fetch;

    await updateCommitStatus({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      commitSha: "abc123",
      state: "pending",
      context: "kumpeapps-bot/deployment/dev",
      description: "Deploying to dev"
    });

    assert.equal(calls.length, 2);
    const method = String(calls[1].init?.method ?? "GET").toUpperCase();
    assert.equal(method, "POST");
    assert.ok(String(calls[1].input).includes("/repos/kumpeapps/repo/check-runs"));
  });

  it("truncates description to 140 characters", async () => {
    appConfig.GITHUB_COMMIT_STATUS_ENABLED = true;

    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const method = String(init?.method ?? "GET").toUpperCase();
      const url = String(input);

      if (method === "GET" && url.includes("/commits/abc123/check-runs")) {
        return makeJsonResponse(200, { total_count: 0, check_runs: [] });
      }

      if (method === "POST" && url.includes("/repos/kumpeapps/repo/check-runs")) {
        return makeJsonResponse(201, { id: 999 });
      }

      return makeJsonResponse(404, { message: "unexpected request" });
    }) as typeof fetch;

    const longDescription = "a".repeat(200);
    await updateCommitStatus({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      commitSha: "abc123",
      state: "pending",
      context: "kumpeapps-bot/deployment/dev",
      description: longDescription
    });

    const body = JSON.parse(String(calls[1].init?.body ?? "{}")) as {
      output?: {
        summary?: string;
      };
    };
    assert.equal(body.output?.summary?.length, 140);
  });
});

describe("waitForWorkflowsToComplete", () => {
  it("ignores deployment bot self-checks", async () => {
    appConfig.GITHUB_WORKFLOW_CHECK_ENABLED = true;
    appConfig.GITHUB_WORKFLOW_CHECK_TIMEOUT_MS = 1_000;
    appConfig.GITHUB_WORKFLOW_CHECK_POLL_INTERVAL_MS = 1;

    globalThis.fetch = (async () =>
      makeJsonResponse(200, {
        total_count: 1,
        check_runs: [
          {
            id: 1,
            name: "kumpeapps-bot/deployment/dev",
            status: "in_progress",
            conclusion: null
          }
        ]
      })) as typeof fetch;

    const result = await waitForWorkflowsToComplete({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      commitSha: "abc123"
    });

    assert.equal(result.totalRuns, 0);
    assert.equal(result.successful, 0);
    assert.equal(result.failed, 0);
  });

  it("waits only on external checks and ignores self-checks", async () => {
    appConfig.GITHUB_WORKFLOW_CHECK_ENABLED = true;
    appConfig.GITHUB_WORKFLOW_CHECK_TIMEOUT_MS = 1_000;
    appConfig.GITHUB_WORKFLOW_CHECK_POLL_INTERVAL_MS = 1;

    globalThis.fetch = (async () =>
      makeJsonResponse(200, {
        total_count: 2,
        check_runs: [
          {
            id: 10,
            name: "Publish backend image",
            status: "completed",
            conclusion: "success"
          },
          {
            id: 11,
            name: "kumpeapps-bot/deployment/dev",
            status: "in_progress",
            conclusion: null
          }
        ]
      })) as typeof fetch;

    const result = await waitForWorkflowsToComplete({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      commitSha: "def456"
    });

    assert.equal(result.totalRuns, 1);
    assert.equal(result.successful, 1);
    assert.equal(result.failed, 0);
  });
});

describe("githubApiHealthStats / githubApiPrometheusMetrics", () => {
  it("tracks final failures and open-circuit skips", async () => {
    appConfig.GITHUB_DEPLOYMENTS_ENABLED = true;
    appConfig.GITHUB_API_POST_MAX_RETRIES = 0;
    appConfig.GITHUB_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 1;
    appConfig.GITHUB_API_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
    appConfig.GITHUB_API_ALERT_FINAL_FAILURES_1H_HIGH = 1;

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return makeJsonResponse(500, { message: "boom" });
    }) as typeof fetch;

    const first = await createGithubDeployment({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      sha: "abc123",
      environment: "dev"
    });
    assert.equal(first, null);

    const second = await createGithubDeployment({
      repositoryOwner: "kumpeapps",
      repositoryName: "repo",
      sha: "def456",
      environment: "dev"
    });
    assert.equal(second, null);
    assert.equal(calls, 1, "second call should be skipped by open circuit");

    const stats = githubApiHealthStats();
    assert.equal(stats.finalFailuresTotal, 1);
    assert.equal(stats.finalFailuresLastHour, 1);
    assert.equal(stats.circuitOpen, true);
    assert.equal(stats.circuitOpenSkipsTotal, 1);
    assert.equal(stats.alerts.finalFailuresLastHourHigh, true);
    assert.equal(stats.alerts.requiresAttention, true);

    const metrics = githubApiPrometheusMetrics();
    assert.match(metrics, /github_api_circuit_open_flag 1/);
    assert.match(metrics, /github_api_alert_final_failures_1hour_high_flag 1/);
    assert.match(metrics, /github_api_alert_requires_attention_flag 1/);
  });
});
