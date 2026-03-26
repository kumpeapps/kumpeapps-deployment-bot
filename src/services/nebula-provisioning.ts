import { recordAuditEvent } from "./audit.js";
import { appConfig } from "../config.js";
import { getGitHubToken } from "./github-app-auth.js";
import naclUtil from "tweetnacl-util";
import sealedBox from "tweetnacl-sealedbox-js";

const { decodeBase64, encodeBase64 } = naclUtil;
const { seal } = sealedBox;

/**
 * Managed Nebula client provisioning service
 * 
 * Automatically creates VPN clients for each environment when a repository is registered.
 * Naming pattern: {environment}-{owner}-{repo}
 */

type Environment = "dev" | "stage" | "prod";

interface NebulaClientCreateRequest {
  name: string;
  is_lighthouse: boolean;
  group_ids: number[];
  pool_id: number;
  ip_group_pool_id?: number;
  ip_type: string;
  firewall_ruleset_ids?: number[];
}

interface NebulaClientResponse {
  id: number;
  name: string;
  ip_address: string;
  token: string;
  is_lighthouse: boolean;
  is_blocked: boolean;
  created_at: string;
}

interface ProvisionResult {
  environment: Environment;
  success: boolean;
  clientId?: number;
  clientName?: string;
  ipAddress?: string;
  token?: string;
  error?: string;
}

/**
 * Make authenticated API request to Managed Nebula
 */
async function nebulaApiCall<T>(
  endpoint: string,
  method: string = "GET",
  body?: any
): Promise<T> {
  if (!appConfig.MANAGED_NEBULA_API_URL || !appConfig.MANAGED_NEBULA_API_KEY) {
    throw new Error("Managed Nebula API is not configured");
  }

  const url = `${appConfig.MANAGED_NEBULA_API_URL}${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${appConfig.MANAGED_NEBULA_API_KEY}`,
    "Content-Type": "application/json"
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(appConfig.MANAGED_NEBULA_API_TIMEOUT_MS)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Managed Nebula API error (${response.status}): ${errorText}`
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Find a Nebula client by name from a cached client list
 * 
 * This helper reduces the number of API calls by allowing the client list to be
 * fetched once and reused for multiple name lookups.
 */
function findClientByName(
  clients: NebulaClientResponse[],
  name: string
): NebulaClientResponse | undefined {
  return clients.find((c) => c.name === name);
}

/**
 * Fetch all Nebula clients (to be cached by calling function)
 */
async function fetchAllClients(): Promise<NebulaClientResponse[]> {
  return nebulaApiCall<NebulaClientResponse[]>("/api/v1/clients", "GET");
}

/**
 * Create a single Nebula client for a repository environment
 */
async function createNebulaClient(
  repositoryOwner: string,
  repositoryName: string,
  environment: Environment
): Promise<NebulaClientResponse> {
  const clientName = `${environment}-${repositoryOwner}-${repositoryName}`;

  const request: NebulaClientCreateRequest = {
    name: clientName,
    is_lighthouse: false,
    group_ids: getGroupIdsForEnvironment(environment),
    pool_id: appConfig.MANAGED_NEBULA_IP_POOL_ID,
    ip_type: "multi_ipv4"
  };

  // Add optional parameters if configured
  if (appConfig.MANAGED_NEBULA_IP_GROUP_POOL_ID) {
    request.ip_group_pool_id = appConfig.MANAGED_NEBULA_IP_GROUP_POOL_ID;
  }

  const firewallRuleIds = getFirewallRuleIdsForEnvironment(environment);
  if (firewallRuleIds.length > 0) {
    request.firewall_ruleset_ids = firewallRuleIds;
  }

  const client = await nebulaApiCall<NebulaClientResponse>(
    "/api/v1/clients",
    "POST",
    request
  );

  return client;
}

/**
 * Get group IDs for an environment from config
 */
function getGroupIdsForEnvironment(environment: Environment): number[] {
  switch (environment) {
    case "dev":
      return appConfig.MANAGED_NEBULA_DEV_GROUP_IDS;
    case "stage":
      return appConfig.MANAGED_NEBULA_STAGE_GROUP_IDS;
    case "prod":
      return appConfig.MANAGED_NEBULA_PROD_GROUP_IDS;
  }
}

/**
 * Get firewall rule IDs for an environment from config
 */
function getFirewallRuleIdsForEnvironment(environment: Environment): number[] {
  switch (environment) {
    case "dev":
      return appConfig.MANAGED_NEBULA_DEV_FIREWALL_RULE_IDS;
    case "stage":
      return appConfig.MANAGED_NEBULA_STAGE_FIREWALL_RULE_IDS;
    case "prod":
      return appConfig.MANAGED_NEBULA_PROD_FIREWALL_RULE_IDS;
  }
}

/**
 * Push a secret to GitHub repository secrets
 */
async function pushSecretToGitHub(input: {
  repositoryOwner: string;
  repositoryName: string;
  secretName: string;
  secretValue: string;
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

    // Step 2: Encrypt the secret using TweetNaCl sealed box
    const publicKeyBytes = decodeBase64(keyData.key);
    const secretBytes = new TextEncoder().encode(input.secretValue);
    const encryptedBytes = seal(secretBytes, publicKeyBytes);
    const encryptedValue = encodeBase64(encryptedBytes);

    // Step 3: Create/update the secret
    const secretUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/actions/secrets/${input.secretName}`;
    
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
 * Provision Nebula clients for all environments when a repository is registered
 * 
 * Creates 3 clients: dev-{owner}-{repo}, stage-{owner}-{repo}, prod-{owner}-{repo}
 * 
 * Also pushes the following secrets to GitHub repository secrets:
 * - DEV_NEBULA_CLIENT_TOKEN, STAGE_NEBULA_CLIENT_TOKEN, PROD_NEBULA_CLIENT_TOKEN
 * - DEV_NEBULA_IP, STAGE_NEBULA_IP, PROD_NEBULA_IP
 * 
 * Returns results for each environment (success/failure)
 */
export async function provisionNebulaClients(input: {
  repositoryOwner: string;
  repositoryName: string;
}): Promise<ProvisionResult[]> {
  // Skip if Nebula provisioning is disabled
  if (!appConfig.MANAGED_NEBULA_ENABLED) {
    return [];
  }

  const environments: Environment[] = ["dev", "stage", "prod"];
  const results: ProvisionResult[] = [];

  for (const environment of environments) {
    try {
      const client = await createNebulaClient(
        input.repositoryOwner,
        input.repositoryName,
        environment
      );

      results.push({
        environment,
        success: true,
        clientId: client.id,
        clientName: client.name,
        ipAddress: client.ip_address,
        token: client.token
      });

      // Record audit event for successful provisioning
      await recordAuditEvent({
        actorType: "system",
        actorId: "nebula-provisioner",
        action: "nebula.client.provisioned",
        resourceType: "nebula_client",
        resourceId: String(client.id),
        payload: {
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          environment,
          clientName: client.name,
          ipAddress: client.ip_address
        }
      });

      // Push token and IP address to GitHub repository secrets
      const envPrefix = environment.toUpperCase();
      
      // Push token
      const tokenResult = await pushSecretToGitHub({
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        secretName: `${envPrefix}_NEBULA_CLIENT_TOKEN`,
        secretValue: client.token
      });

      if (tokenResult.success) {
        await recordAuditEvent({
          actorType: "system",
          actorId: "nebula-provisioner",
          action: "nebula.secret.pushed",
          resourceType: "github_secret",
          resourceId: `${envPrefix}_NEBULA_CLIENT_TOKEN`,
          payload: {
            repositoryOwner: input.repositoryOwner,
            repositoryName: input.repositoryName,
            environment,
            secretName: `${envPrefix}_NEBULA_CLIENT_TOKEN`
          }
        });
      } else {
        await recordAuditEvent({
          actorType: "system",
          actorId: "nebula-provisioner",
          action: "nebula.secret.push.failed",
          resourceType: "github_secret",
          resourceId: `${envPrefix}_NEBULA_CLIENT_TOKEN`,
          payload: {
            repositoryOwner: input.repositoryOwner,
            repositoryName: input.repositoryName,
            environment,
            secretName: `${envPrefix}_NEBULA_CLIENT_TOKEN`,
            error: tokenResult.error
          }
        });
      }

      // Push IP address
      const ipResult = await pushSecretToGitHub({
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        secretName: `${envPrefix}_NEBULA_IP`,
        secretValue: client.ip_address
      });

      if (ipResult.success) {
        await recordAuditEvent({
          actorType: "system",
          actorId: "nebula-provisioner",
          action: "nebula.secret.pushed",
          resourceType: "github_secret",
          resourceId: `${envPrefix}_NEBULA_IP`,
          payload: {
            repositoryOwner: input.repositoryOwner,
            repositoryName: input.repositoryName,
            environment,
            secretName: `${envPrefix}_NEBULA_IP`
          }
        });
      } else {
        await recordAuditEvent({
          actorType: "system",
          actorId: "nebula-provisioner",
          action: "nebula.secret.push.failed",
          resourceType: "github_secret",
          resourceId: `${envPrefix}_NEBULA_IP`,
          payload: {
            repositoryOwner: input.repositoryOwner,
            repositoryName: input.repositoryName,
            environment,
            secretName: `${envPrefix}_NEBULA_IP`,
            error: ipResult.error
          }
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      results.push({
        environment,
        success: false,
        error: errorMessage
      });

      // Record audit event for failed provisioning
      await recordAuditEvent({
        actorType: "system",
        actorId: "nebula-provisioner",
        action: "nebula.client.provision.failed",
        resourceType: "nebula_client",
        resourceId: "unknown",
        payload: {
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          environment,
          error: errorMessage
        }
      });
    }
  }

  return results;
}

/**
 * Deprovision (delete) Nebula clients for a repository when it's removed
 * 
 * Attempts to remove all 3 environment clients
 */
export async function deprovisionNebulaClients(input: {
  repositoryOwner: string;
  repositoryName: string;
}): Promise<{ environment: Environment; success: boolean; error?: string }[]> {
  // Skip if Nebula provisioning is disabled
  if (!appConfig.MANAGED_NEBULA_ENABLED) {
    return [];
  }

  const environments: Environment[] = ["dev", "stage", "prod"];
  const results: { environment: Environment; success: boolean; error?: string }[] = [];

  // Fetch client list once and cache for all lookups (optimization)
  let clients: NebulaClientResponse[];
  try {
    clients = await fetchAllClients();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    // If we can't fetch the list, fail all environments
    return environments.map(env => ({
      environment: env,
      success: false,
      error: `Failed to fetch client list: ${errorMessage}`
    }));
  }

  for (const environment of environments) {
    const clientName = `${environment}-${input.repositoryOwner}-${input.repositoryName}`;

    try {
      // Find the client from cached list
      const client = findClientByName(clients, clientName);

      if (client) {
        // Delete the client
        await nebulaApiCall(`/api/v1/clients/${client.id}`, "DELETE");

        results.push({
          environment,
          success: true
        });

        await recordAuditEvent({
          actorType: "system",
          actorId: "nebula-provisioner",
          action: "nebula.client.deprovisioned",
          resourceType: "nebula_client",
          resourceId: String(client.id),
          payload: {
            repositoryOwner: input.repositoryOwner,
            repositoryName: input.repositoryName,
            environment,
            clientName
          }
        });
      } else {
        results.push({
          environment,
          success: true // Not an error if client doesn't exist
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      results.push({
        environment,
        success: false,
        error: errorMessage
      });

      await recordAuditEvent({
        actorType: "system",
        actorId: "nebula-provisioner",
        action: "nebula.client.deprovision.failed",
        resourceType: "nebula_client",
        resourceId: "unknown",
        payload: {
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          environment,
          error: errorMessage
        }
      });
    }
  }

  return results;
}

/**
 * Revoke Nebula certificate for a specific environment when VM is deleted
 * 
 * This forces certificate rotation without deleting the client or token.
 * The next time the client connects, it will get a fresh certificate.
 * 
 * Note: This function is called once per VM deletion. If you need to revoke multiple
 * certificates in a batch operation, consider fetching the client list once and
 * passing it to an optimized batch version of this function.
 */
export async function revokeNebulaCertificate(input: {
  repositoryOwner: string;
  repositoryName: string;
  environment: Environment;
}): Promise<{ success: boolean; error?: string }> {
  // Skip if Nebula provisioning is disabled
  if (!appConfig.MANAGED_NEBULA_ENABLED) {
    return { success: true }; // Not an error if disabled
  }

  const clientName = `${input.environment}-${input.repositoryOwner}-${input.repositoryName}`;

  try {
    // Fetch and find the client by name
    // Note: For single operations this is acceptable, but if revoking multiple
    // certificates in a batch, consider fetching the list once and reusing it
    const clients = await fetchAllClients();
    const client = findClientByName(clients, clientName);

    if (!client) {
      // Client doesn't exist - not an error
      return { success: true };
    }

    // Reissue certificate (this revokes the old one)
    await nebulaApiCall(
      `/api/v1/clients/${client.id}/certificates/reissue`,
      "POST"
    );

    await recordAuditEvent({
      actorType: "system",
      actorId: "nebula-provisioner",
      action: "nebula.certificate.revoked",
      resourceType: "nebula_client",
      resourceId: String(client.id),
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        environment: input.environment,
        clientName,
        reason: "VM deleted"
      }
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await recordAuditEvent({
      actorType: "system",
      actorId: "nebula-provisioner",
      action: "nebula.certificate.revoke.failed",
      resourceType: "nebula_client",
      resourceId: "unknown",
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        environment: input.environment,
        clientName,
        error: errorMessage
      }
    });

    return {
      success: false,
      error: errorMessage
    };
  }
}
