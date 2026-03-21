import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "fs";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";

/**
 * GitHub App authentication service.
 * Generates and caches installation tokens for repositories.
 * Tokens are valid for 1 hour and automatically refreshed.
 */

type TokenCache = {
  token: string;
  expiresAt: Date;
};

const tokenCache = new Map<bigint, TokenCache>();

/**
 * Get the GitHub App private key from environment.
 * Supports both direct key content and file path.
 */
function getPrivateKey(): string | null {
  // First check if GITHUB_APP_PRIVATE_KEY is set directly
  if (appConfig.GITHUB_APP_PRIVATE_KEY && appConfig.GITHUB_APP_PRIVATE_KEY.trim().length > 0) {
    // Handle escaped newlines in env var
    return appConfig.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  }

  // Fall back to reading from file path
  if (appConfig.GITHUB_APP_PRIVATE_KEY_PATH && appConfig.GITHUB_APP_PRIVATE_KEY_PATH.trim().length > 0) {
    try {
      return readFileSync(appConfig.GITHUB_APP_PRIVATE_KEY_PATH, "utf-8");
    } catch (error) {
      console.error(`Failed to read GitHub App private key from ${appConfig.GITHUB_APP_PRIVATE_KEY_PATH}:`, error);
      return null;
    }
  }

  return null;
}

/**
 * Check if GitHub App authentication is configured and available.
 */
export function isGitHubAppAuthConfigured(): boolean {
  if (!appConfig.GITHUB_APP_ID) {
    return false;
  }

  const privateKey = getPrivateKey();
  return privateKey !== null && privateKey.length > 0;
}

/**
 * Get an installation token for a specific repository.
 * Returns null if GitHub App auth is not configured or installation not found.
 */
export async function getInstallationToken(
  repositoryOwner: string,
  repositoryName: string
): Promise<string | null> {
  if (!isGitHubAppAuthConfigured()) {
    return null;
  }

  // Look up installation ID for this repository
  const repo = await prisma.repository.findUnique({
    where: {
      owner_name: {
        owner: repositoryOwner,
        name: repositoryName
      }
    },
    select: {
      installationId: true
    }
  });

  if (!repo || !repo.installationId) {
    return null;
  }

  const installationId = repo.installationId;

  // Check cache first
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > new Date()) {
    return cached.token;
  }

  // Generate new token
  try {
    const privateKey = getPrivateKey();
    if (!privateKey) {
      return null;
    }

    const auth = createAppAuth({
      appId: appConfig.GITHUB_APP_ID!,
      privateKey: privateKey,
      installationId: Number(installationId)
    });

    const { token, expiresAt } = await auth({ type: "installation" });

    // Cache the token (subtract 5 minutes for safety margin)
    const cacheExpiresAt = new Date(expiresAt);
    cacheExpiresAt.setMinutes(cacheExpiresAt.getMinutes() - 5);

    tokenCache.set(installationId, {
      token,
      expiresAt: cacheExpiresAt
    });

    return token;
  } catch (error) {
    console.error(`Failed to generate installation token for installation ${installationId}:`, error);
    return null;
  }
}

/**
 * Get a GitHub API token for a repository.
 * Tries installation token first, falls back to static GITHUB_API_TOKEN.
 */
export async function getGitHubToken(
  repositoryOwner: string,
  repositoryName: string
): Promise<string> {
  // Try GitHub App installation token first
  const installationToken = await getInstallationToken(repositoryOwner, repositoryName);
  if (installationToken) {
    return installationToken;
  }

  // Fall back to static token
  return appConfig.GITHUB_API_TOKEN.trim();
}

/**
 * Clear the token cache for a specific installation.
 * Useful when an installation is removed or needs to be refreshed.
 */
export function clearTokenCache(installationId: bigint): void {
  tokenCache.delete(installationId);
}

/**
 * Clear all cached tokens.
 */
export function clearAllTokenCache(): void {
  tokenCache.clear();
}
