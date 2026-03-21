/**
 * Repository API Token Management
 *
 * Generates and manages per-repository API tokens for secure secret synchronization.
 * When a repository is added to the GitHub App installation, a unique token is:
 * 1. Generated and stored in the bot's database
 * 2. Pushed to the repository as a secret (KUMPEAPPS_DEPLOY_BOT_TOKEN)
 *
 * This allows repositories to use the action without manual token setup.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { getGitHubToken } from "./github-app-auth.js";
import { recordAuditEvent } from "./audit.js";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import sealedBox from "tweetnacl-sealedbox-js";

const { decodeBase64, encodeBase64 } = naclUtil;
const { seal } = sealedBox;

const TOKEN_PREFIX = "kdbt_"; // kumpeapps-deployment-bot-token
const TOKEN_BYTE_LENGTH = 32;
const GITHUB_SECRET_NAME = "KUMPEAPPS_DEPLOY_BOT_TOKEN";

/**
 * Generate a new repository API token
 */
function generateToken(): string {
  const randomPart = randomBytes(TOKEN_BYTE_LENGTH).toString("base64url");
  return `${TOKEN_PREFIX}${randomPart}`;
}

/**
 * Create or retrieve API token for a repository
 */
async function ensureRepositoryToken(repositoryId: number): Promise<string> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { apiToken: true }
  });

  if (!repository) {
    throw new Error(`Repository ${repositoryId} not found`);
  }

  // Return existing token if present
  if (repository.apiToken) {
    return repository.apiToken;
  }

  // Generate and store new token
  const token = generateToken();
  await prisma.repository.update({
    where: { id: repositoryId },
    data: { apiToken: token }
  });

  return token;
}

/**
 * Push repository API token to GitHub as a secret
 */
async function pushTokenToGitHub(input: {
  repositoryOwner: string;
  repositoryName: string;
  token: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const githubToken = await getGitHubToken(input.repositoryOwner, input.repositoryName);
    if (!githubToken) {
      return { success: false, error: "No GitHub App token available" };
    }

    // Step 1: Get repository public key for secret encryption
    const keyUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/actions/secrets/public-key`;
    
    const keyResponse = await fetch(keyUrl, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${githubToken}`,
        "User-Agent": "kumpeapps-deployment-bot"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!keyResponse.ok) {
      return { 
        success: false, 
        error: `Failed to get public key: HTTP ${keyResponse.status}` 
      };
    }

    const keyData = await keyResponse.json() as { key: string; key_id: string };

    // Step 2: Encrypt the token using TweetNaCl sealed box
    // Convert the public key from base64 to Uint8Array
    const publicKeyBytes = decodeBase64(keyData.key);
    
    // Convert the token string to Uint8Array
    const tokenBytes = new TextEncoder().encode(input.token);
    
    // Encrypt using sealed box (anonymous encryption)
    const encryptedBytes = seal(tokenBytes, publicKeyBytes);
    
    // Convert encrypted bytes to base64
    const encryptedValue = encodeBase64(encryptedBytes);

    // Step 3: Create/update the secret
    const secretUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/actions/secrets/${GITHUB_SECRET_NAME}`;
    
    const secretResponse = await fetch(secretUrl, {
      method: "PUT",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${githubToken}`,
        "User-Agent": "kumpeapps-deployment-bot",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: keyData.key_id
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!secretResponse.ok) {
      const errorText = await secretResponse.text();
      return { 
        success: false, 
        error: `Failed to create secret: HTTP ${secretResponse.status} - ${errorText}` 
      };
    }

    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : "Unknown error" 
    };
  }
}

/**
 * Provision API token for a repository and push it to GitHub
 * Called when a repository is added to the installation
 */
export async function provisionRepositoryToken(input: {
  repositoryOwner: string;
  repositoryName: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    // Find repository
    const repository = await prisma.repository.findUnique({
      where: {
        owner_name: {
          owner: input.repositoryOwner,
          name: input.repositoryName
        }
      }
    });

    if (!repository) {
      return { success: false, error: "Repository not found in database" };
    }

    // Ensure token exists
    const token = await ensureRepositoryToken(repository.id);

    // Push to GitHub
    const result = await pushTokenToGitHub({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      token
    });

    if (result.success) {
      await recordAuditEvent({
        actorType: "system",
        actorId: "token-provisioner",
        action: "repository.token.provisioned",
        resourceType: "repository",
        resourceId: String(repository.id),
        payload: {
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          secretName: GITHUB_SECRET_NAME
        }
      });
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

/**
 * Validate a repository API token
 */
export async function validateRepositoryToken(input: {
  repositoryOwner: string;
  repositoryName: string;
  token: string;
}): Promise<boolean> {
  const repository = await prisma.repository.findUnique({
    where: {
      owner_name: {
        owner: input.repositoryOwner,
        name: input.repositoryName
      }
    },
    select: { apiToken: true }
  });

  if (!repository || !repository.apiToken) {
    return false;
  }

  return repository.apiToken === input.token;
}
