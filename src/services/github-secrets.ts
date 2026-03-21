/**
 * GitHub Repository Secrets API client.
 *
 * Fetches repository secrets from GitHub API with retry and circuit breaker.
 * Secrets are resolved at deployment time and cached in deployment records for audit.
 */

import { appConfig } from "../config.js";
import { getGitHubToken } from "./github-app-auth.js";
import {
  recordGithubSecretReadAttempt,
  recordGithubSecretReadSuccess,
  recordGithubSecretReadFailure
} from "./github-secrets-health.js";

type GithubSecretsResponse = {
  secrets?: Array<{
    name: string;
    value?: string;
    updated_at?: string;
  }>;
};

let githubSecretApiConsecutiveFailures = 0;
let githubSecretApiCircuitOpenedAtMs: number | null = null;

function isCircuitOpen(nowMs: number): boolean {
  if (githubSecretApiCircuitOpenedAtMs === null) {
    return false;
  }

  const cooldownMs = appConfig.GITHUB_API_CIRCUIT_BREAKER_COOLDOWN_MS;
  if (nowMs - githubSecretApiCircuitOpenedAtMs >= cooldownMs) {
    githubSecretApiCircuitOpenedAtMs = null;
    githubSecretApiConsecutiveFailures = 0;
    return false;
  }

  return true;
}

function markFailure(): void {
  githubSecretApiConsecutiveFailures += 1;
  if (githubSecretApiConsecutiveFailures >= appConfig.GITHUB_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    githubSecretApiCircuitOpenedAtMs = Date.now();
  }
}

function markSuccess(): void {
  githubSecretApiConsecutiveFailures = 0;
  githubSecretApiCircuitOpenedAtMs = null;
}

async function authHeaders(repositoryOwner: string, repositoryName: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "kumpeapps-deployment-bot"
  };

  const token = await getGitHubToken(repositoryOwner, repositoryName);
  if (token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch public repo secrets from GitHub API.
 * Returns null if circuit is open or API is unavailable.
 */
export async function fetchGithubRepositorySecrets(input: {
  repositoryOwner: string;
  repositoryName: string;
}): Promise<Record<string, string> | null> {
  const nowMs = Date.now();

  if (isCircuitOpen(nowMs)) {
    return null;
  }

  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    // No token configured; GitHub secret reading is disabled
    return null;
  }

  const maxRetries = appConfig.GITHUB_API_POST_MAX_RETRIES;
  const baseDelayMs = appConfig.GITHUB_API_POST_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    recordGithubSecretReadAttempt({ isRetry: attempt > 0 });

    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/actions/secrets`;

      const response = await fetch(url, {
        headers: await authHeaders(input.repositoryOwner, input.repositoryName),
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        // Treat 404, 403, etc. as non-transient for now
        if (response.status === 404 || response.status === 403) {
          return {}; // Return empty secrets for permission/not-found
        }

        const isTransient = response.status === 429 || response.status >= 500;
        if (isTransient && attempt < maxRetries) {
          await sleep(baseDelayMs * Math.pow(2, attempt));
          continue;
        }

        throw new Error(`GitHub secrets API returned ${response.status}`);
      }

      const data = (await response.json()) as GithubSecretsResponse;
      const secretsByName: Record<string, string> = {};

      // Note: GitHub API does not return secret values directly;
      // only metadata. For actual secret resolution, the bot needs to:
      // 1. Authenticate as the repository's installation
      // 2. Use GitHub's "Get repository secret" endpoint if available
      // For now, we return secret names and mark them as "metadata-only"
      if (data.secrets) {
        for (const secret of data.secrets) {
          secretsByName[secret.name] = `__github_secret_${secret.name}`;
        }
      }

      recordGithubSecretReadSuccess();
      markSuccess();
      return secretsByName;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      const isTimeout = message.toLowerCase().includes("timeout");

      if (attempt < maxRetries) {
        await sleep(baseDelayMs * Math.pow(2, attempt));
        continue;
      }

      recordGithubSecretReadFailure({ timedOut: isTimeout });
      markFailure();
      return null;
    }
  }

  recordGithubSecretReadFailure({ timedOut: false });
  markFailure();
  return null;
}
