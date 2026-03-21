import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { appConfig } from "../config.js";
import {
  __resetGithubApiCircuitBreakerForTests,
  createGithubDeployment,
  githubApiHealthStats,
  githubApiPrometheusMetrics,
  updateGithubDeploymentStatus
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
