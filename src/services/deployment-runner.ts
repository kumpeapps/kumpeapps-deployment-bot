import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";
import { recordAuditEvent } from "./audit.js";
import {
  type DeploymentConfig,
  validateDeploymentPolicy,
  validateCaddyfileDomains
} from "../schemas/deployment-config.js";
import { compensateComposeOnVm, deployCaddyConfig, deployComposeToVm } from "./ssh-deployer.js";
import { resolveRepositoryEnvValues } from "./repository-secrets.js";
import { ensureVirtualizorVm, resolvePlanDetails } from "./virtualizor.js";
import { createGithubDeployment, updateGithubDeploymentStatus, updateCommitStatus, waitForWorkflowsToComplete, reportDeploymentError, closeDeploymentErrorIssue } from "./github-status.js";
import { recordDeploymentCompensationEvent } from "./deployment-compensation-health.js";
import { buildVmHostname, checkVmApprovalStatus, createVmApprovalRequest } from "./vm-approval.js";
import { getGitHubToken } from "./github-app-auth.js";
import { syncAuthorizedAdminsToVm } from "./vm-user-management.js";
import { fetchFileFromGitHub } from "./github-automation.js";
import { getNebulaIpAddress } from "./nebula-provisioning.js";

/**
 * Custom error for VM approval pending state.
 * Not a real error - just a signal that deployment should wait.
 */
export class VmApprovalPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VmApprovalPendingError";
  }
}

export type ExecuteDeploymentInput = {
  repositoryOwner: string;
  repositoryName: string;
  environment: "dev" | "stage" | "prod";
  commitSha: string;
  triggeredBy?: string;
  caddyHost: string;
  configPath: string;
  config: DeploymentConfig;
  dryRun: boolean;
  dryRunOnlyGuard: boolean;
};

async function createStep(deploymentId: number, stepName: string): Promise<number> {
  const step = await prisma.deploymentStep.create({
    data: {
      deploymentId,
      stepName,
      status: "running"
    }
  });

  return step.id;
}

async function completeStep(stepId: number, status: "success" | "failed", logExcerpt?: string): Promise<void> {
  await prisma.deploymentStep.update({
    where: { id: stepId },
    data: {
      status,
      logExcerpt,
      finishedAt: new Date()
    }
  });
}

async function runStep<T>(
  deploymentId: number,
  stepName: string,
  action: () => Promise<T>,
  successLog?: string | ((result: T) => string)
): Promise<T> {
  const stepId = await createStep(deploymentId, stepName);
  try {
    const result = await action();
    const log =
      typeof successLog === "function"
        ? successLog(result)
        : successLog;
    await completeStep(stepId, "success", log);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    await completeStep(stepId, "failed", message);
    throw error;
  }
}

async function auditSecretMappings(
  deploymentId: number,
  envMappings: Record<string, string>,
  unresolved: Array<{ envKey: string; secretName: string }>
): Promise<void> {
  const unresolvedSet = new Set(unresolved.map((item) => `${item.envKey}:${item.secretName}`));
  const rows = Object.entries(envMappings).map(([envKey, secretName]) => ({
    deploymentId,
    envKey,
    secretName,
    resolved: !unresolvedSet.has(`${envKey}:${secretName}`)
  }));

  if (rows.length === 0) {
    return;
  }

  await prisma.secretsResolutionAudit.createMany({ data: rows });
}

function deploymentLogUrl(deploymentId: number): string {
  return `${appConfig.APP_PUBLIC_BASE_URL.replace(/\/$/, "")}/deployments/${deploymentId}/status`;
}

/**
 * Helper to centralize commit status updates for deployments
 */
async function setDeploymentCommitStatus(
  input: {
    repositoryOwner: string;
    repositoryName: string;
    commitSha: string;
    environment: string;
  },
  options: {
    state: "pending" | "success" | "failure";
    description: string;
    deploymentId?: number;
    targetUrlOverride?: string;
  }
): Promise<void> {
  const targetUrl =
    options.targetUrlOverride ??
    (options.deploymentId ? deploymentLogUrl(options.deploymentId) : appConfig.APP_PUBLIC_BASE_URL);

  await updateCommitStatus({
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    commitSha: input.commitSha,
    state: options.state,
    context: `kumpeapps-bot/deployment/${input.environment}`,
    description: options.description,
    targetUrl,
  });
}

type CompensationActionName = "vm.compose_down";

type CompensationResult = {
  state: "not_required" | "succeeded" | "failed";
  attempted: number;
  succeeded: number;
  failed: number;
  actions: CompensationActionName[];
  errors: string[];
};

async function runCompensationPlan(input: {
  deploymentId: number;
  vmHostname: string;
  vmIp?: string;
  dryRun: boolean;
  vmComposeDeployed: boolean;
}): Promise<CompensationResult> {
  const actions: CompensationActionName[] = [];
  const errors: string[] = [];
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  if (input.vmComposeDeployed && appConfig.DEPLOY_COMPENSATION_VM_COMPOSE_DOWN_ENABLED) {
    actions.push("vm.compose_down");
  }

  for (const action of actions) {
    recordDeploymentCompensationEvent({ state: "planned" });
  }

  if (actions.length === 0) {
    return {
      state: "not_required",
      attempted,
      succeeded,
      failed,
      actions,
      errors
    };
  }

  for (const action of actions) {
    attempted += 1;
    recordDeploymentCompensationEvent({ state: "attempted" });

    try {
      if (action === "vm.compose_down") {
        await runStep(
          input.deploymentId,
          "compensation.vm.compose_down",
          async () =>
            compensateComposeOnVm({
              vmHostname: input.vmHostname,
              vmIp: input.vmIp || input.vmHostname,
              dryRun: input.dryRun,
              sshUser: appConfig.VM_SSH_USER,
              sshKeyPath: appConfig.VM_SSH_KEY_PATH,
              sshPort: appConfig.VM_SSH_PORT, // No config override available in compensation context
              remoteBaseDir: appConfig.VM_DEPLOY_BASE_DIR
            }),
          (stdout) => stdout
        );
      }

      succeeded += 1;
      recordDeploymentCompensationEvent({ state: "succeeded" });
    } catch (error) {
      failed += 1;
      recordDeploymentCompensationEvent({ state: "failed" });
      errors.push(error instanceof Error ? error.message : "unknown compensation error");
    }
  }

  return {
    state: failed > 0 ? "failed" : "succeeded",
    attempted,
    succeeded,
    failed,
    actions,
    errors
  };
}

/**
 * Resolve file content - either inline or from a file reference
 * 
 * @param content - Either inline content (contains newlines) or a file path
 * @param configPath - Path to the deployment config file (for resolving relative paths)
 * @param repositoryOwner - Repository owner
 * @param repositoryName - Repository name
 * @param commitSha - Git commit SHA to fetch from
 * @returns Resolved file content
 */
async function resolveFileContent(input: {
  content: string;
  configPath: string;
  repositoryOwner: string;
  repositoryName: string;
  commitSha: string;
}): Promise<string> {
  const trimmed = input.content.trim();
  
  // Detect inline content: contains newlines or starts with version/services (docker-compose indicators)
  const isInlineContent = 
    trimmed.includes('\n') || 
    trimmed.startsWith('version:') ||
    trimmed.startsWith('services:') ||
    trimmed.startsWith('name:');
  
  if (isInlineContent) {
    return trimmed;
  }
  
  // It's a file path - resolve it
  let resolvedPath = trimmed;
  
  // Get the directory of the config file
  const configDir = input.configPath.substring(0, input.configPath.lastIndexOf('/'));
  
  // Handle relative paths
  if (resolvedPath.startsWith('./')) {
    // Same directory as config
    resolvedPath = `${configDir}/${resolvedPath.substring(2)}`;
  } else if (resolvedPath.startsWith('../')) {
    // Parent directory - resolve relative to config
    const parts = configDir.split('/');
    const upLevels = (resolvedPath.match(/\.\.\//g) || []).length;
    const remainingPath = resolvedPath.replace(/^(\.\.\/)+/, '');
    
    if (upLevels >= parts.length) {
      throw new Error(`Invalid path: ${resolvedPath} goes above repository root`);
    }
    
    resolvedPath = `${parts.slice(0, parts.length - upLevels).join('/')}/${remainingPath}`;
  } else if (!resolvedPath.startsWith('/') && !resolvedPath.includes('/')) {
    // Just a filename - default to config directory
    resolvedPath = `${configDir}/${resolvedPath}`;
  } else if (resolvedPath.startsWith('/')) {
    // Absolute path from repository root - remove leading slash
    resolvedPath = resolvedPath.substring(1);
  }
  
  // Normalize path (remove double slashes, etc.)
  resolvedPath = resolvedPath.replace(/\/+/g, '/');
  
  // Fetch the file from GitHub
  try {
    const content = await fetchFileFromGitHub({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      path: resolvedPath,
      ref: input.commitSha
    });
    
    return content;
  } catch (error) {
    throw new Error(`Failed to fetch file ${resolvedPath}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Injects Managed Nebula client service into docker-compose content.
 * Replaces the first occurrence of "services:" with the template that includes
 * the nebula client service plus "services:" to maintain structure.
 * 
 * Example transformation:
 * Input:                          Output:
 * version: '3.8'                  version: '3.8'
 * services:                       services:
 *   web:                            client:  # injected
 *     image: myapp                    image: nebula-client
 *                                   web:     # original services follow
 *                                     image: myapp
 */
async function injectNebulaClient(dockerComposeContent: string): Promise<string> {
  try {
    // Read the nebula client template
    const templatePath = join(process.cwd(), 'templates', 'mobile-nebula-docker-config.yml');
    const nebulaTemplate = await readFile(templatePath, 'utf-8');
    
    // Replace the first occurrence of "services:" (on its own line) with the template
    // The template already includes "services:" at the top, so this will inject
    // the nebula client as the first service in the compose file
    const injected = dockerComposeContent.replace(/^services:\s*$/m, nebulaTemplate.trim());
    
    if (injected === dockerComposeContent) {
      // If no replacement occurred, the docker-compose file might not have
      // a standard "services:" line - log a warning but continue
      console.warn('[Deployment Runner] Warning: Could not inject Nebula client - "services:" not found on separate line');
    }
    
    return injected;
  } catch (error) {
    throw new Error(`Failed to inject Nebula client: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

export async function executeDeployment(input: ExecuteDeploymentInput): Promise<{ deploymentId: number }> {
  if (input.dryRunOnlyGuard && !input.dryRun) {
    throw new Error("Runtime is configured as dry-run only");
  }

  const repository = await prisma.repository.findUnique({
    where: {
      owner_name: {
        owner: input.repositoryOwner,
        name: input.repositoryName
      }
    }
  });

  if (!repository) {
    throw new Error("Repository not found in control plane");
  }

  // Create commit status check immediately so it shows even if deployment fails authorization
  // This ensures status checks appear when deployment is triggered, regardless of outcome
  await setDeploymentCommitStatus(input, {
    state: "pending",
    description: `Deploying to ${input.environment}...`
  });

  const assignedUsername = input.config.assigned_username.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { githubUsername: assignedUsername },
    include: {
      limits: true,
      approvedDomains: true,
      authorizedPlans: true
    }
  });

  if (!user || user.status !== "approved") {
    const errorMessage = "Assigned user is not approved";
    
    // Update commit status to failure
    await setDeploymentCommitStatus(input, {
      state: "failure",
      description: errorMessage
    });
    
    throw new Error(errorMessage);
  }

  // Build VM hostname from config with intelligent username and env prefixing
  const vmHostname = buildVmHostname({
    assignedUsername,
    environment: input.environment,
    customHostname: input.config.vm_hostname
  });

  // Check if VM already exists for this repository and environment
  const existingVm = await prisma.vm.findUnique({
    where: {
      repositoryId_environment: {
        repositoryId: repository.id,
        environment: input.environment
      }
    }
  });

  // Count existing VMs for the user
  const existingVmCount = await prisma.vm.count({
    where: {
      userId: user.id
    }
  });

  // For policy validation: if VM exists, we're reusing it (subtract 1 because it will be replaced)
  // If VM doesn't exist, we're creating new one (use actual count, policy will add 1)
  const vmCountForPolicy = existingVm ? existingVmCount - 1 : existingVmCount;

  const policyErrors = validateDeploymentPolicy({
    config: input.config,
    expectedUsername: assignedUsername,
    approvedDomains: user.approvedDomains.map((item: { domain: string }) => item.domain),
    authorizedPlans: user.authorizedPlans.map((item: { planName: string }) => item.planName),
    maxDomains: user.limits?.maxDomains ?? 0,
    maxVms: user.limits?.maxVms ?? 0,
    currentVmCount: vmCountForPolicy
  });

  if (policyErrors.length > 0) {
    const errorMessage = `Policy validation failed: ${policyErrors.join("; ")}`;
    
    // Update commit status to failure
    await setDeploymentCommitStatus(input, {
      state: "failure",
      description: "Policy validation failed"
    });
    
    // Report policy error as GitHub issue before throwing
    if (appConfig.GITHUB_DEPLOYMENT_ERROR_ISSUES_ENABLED) {
      try {
        await reportDeploymentError({
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          environment: input.environment,
          commitSha: input.commitSha,
          errorMessage,
          deploymentId: 0, // No deployment record created yet
          logUrl: undefined
        });
      } catch (issueError) {
        console.error(`[Deployment Runner] Failed to create policy error issue:`, issueError);
      }
    }
    
    throw new Error(errorMessage);
  }

  const resolvedSecrets = await resolveRepositoryEnvValues({
    repositoryId: repository.id,
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    envMappings: input.config.env_mappings
  });

  if (!input.dryRun && resolvedSecrets.unresolved.length > 0) {
    const missing = resolvedSecrets.unresolved.map((item) => `${item.envKey}:${item.secretName}`).join(", ");
    const errorMessage = `Missing repository secret values for env mappings: ${missing}`;
    
    // Update commit status to failure
    await setDeploymentCommitStatus(input, {
      state: "failure",
      description: "Missing required secrets"
    });
    
    throw new Error(errorMessage);
  }

  const deploymentKey = createHash("sha256")
    .update(
      JSON.stringify({
        repositoryId: repository.id,
        environment: input.environment,
        commitSha: input.commitSha,
        configPath: input.configPath,
        configHash: createHash("sha256").update(JSON.stringify(input.config)).digest("hex")
      })
    )
    .digest("hex");

  const existingDeployment = await prisma.deployment.findUnique({
    where: { deploymentKey }
  });

  if (existingDeployment && existingDeployment.status === "succeeded") {
    console.log(`[Deployment Runner] Skipping duplicate deployment (existing id: ${existingDeployment.id}, status: ${existingDeployment.status})`);
    await recordAuditEvent({
      actorType: "system",
      actorId: input.triggeredBy ?? "unknown",
      action: "deployment.skipped_duplicate",
      resourceType: "deployment",
      resourceId: String(existingDeployment.id),
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        environment: input.environment,
        commitSha: input.commitSha,
        configPath: input.configPath
      }
    });

    return { deploymentId: existingDeployment.id };
  }

  console.log(`[Deployment Runner] Starting deployment ${existingDeployment ? `(reusing deployment id ${existingDeployment.id})` : '(new deployment)'} for commit ${input.commitSha.substring(0, 7)}`);

  // If existing deployment is failed or running, reuse it for retry
  const deployment = existingDeployment ?? await prisma.deployment.create({
    data: {
      repositoryId: repository.id,
      environment: input.environment,
      deploymentKey,
      triggeredBy: input.triggeredBy,
      commitSha: input.commitSha,
      status: "running"
    }
  });

  // Create GitHub Deployment and mark in_progress (best-effort)
  const githubDeploymentId = await createGithubDeployment({
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    sha: input.commitSha,
    environment: input.environment
  });

  if (githubDeploymentId !== null) {
    const logUrl = deploymentLogUrl(deployment.id);
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { githubDeploymentId }
    });
    await updateGithubDeploymentStatus({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      githubDeploymentId,
      state: "in_progress",
      logUrl
    });
  }

  // Update commit status with deployment log URL now that we have a deployment ID
  await setDeploymentCommitStatus(input, {
    state: "pending",
    description: `Deploying to ${input.environment}...`,
    deploymentId: deployment.id
  });

  await recordAuditEvent({
    actorType: "system",
    actorId: input.triggeredBy ?? "unknown",
    action: "deployment.started",
    resourceType: "deployment",
    resourceId: String(deployment.id),
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      environment: input.environment,
      commitSha: input.commitSha,
      dryRun: input.dryRun
    }
  });

  const configHash = createHash("sha256").update(JSON.stringify(input.config)).digest("hex");
  await prisma.deploymentConfig.upsert({
    where: {
      repositoryId_environment_configPath: {
        repositoryId: repository.id,
        environment: input.environment,
        configPath: input.configPath
      }
    },
    update: {
      configHash,
      parsedJson: input.config,
      lastSeenCommitSha: input.commitSha
    },
    create: {
      repositoryId: repository.id,
      environment: input.environment,
      configPath: input.configPath,
      configHash,
      parsedJson: input.config,
      lastSeenCommitSha: input.commitSha
    }
  });

  let vmComposeDeployed = false;
  let vmIp: string | undefined;

  try {
    // Wait for GitHub Actions workflows to complete before deploying
    await runStep(
      deployment.id,
      "github.check_workflows",
      async () => {
        const result = await waitForWorkflowsToComplete({
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          commitSha: input.commitSha
        });
        return result;
      },
      (result) => `Workflows complete: ${result.successful} successful, ${result.failed} failed`
    );
    
    console.log(`[Deployment Runner] VM hostname: ${vmHostname} (user: ${assignedUsername})`);
    
    // Check if VM approval is required
    await runStep(
      deployment.id,
      "vm.check_approval",
      async () => {
        const approvalStatus = await checkVmApprovalStatus({
          repositoryFullName: `${input.repositoryOwner}/${input.repositoryName}`,
          environment: input.environment
        });
        
        if (approvalStatus.status === "pending") {
          throw new VmApprovalPendingError(`VM creation pending approval. Waiting for @${assignedUsername} to approve issue #${approvalStatus.issueNumber}`);
        }
        
        if (approvalStatus.status === "rejected") {
          throw new Error(`VM creation was rejected`);
        }
        
        // If no approval exists yet (cancelled status), create approval request
        if (approvalStatus.status === "cancelled") {
          // Fetch plan details from Virtualizor to include in approval issue
          let planDisplayName = input.config.plan_name;
          let planSpecs = {
            ram: "8192",
            disk: "32",
            cores: "2"
          };
          
          try {
            const planInfo = await resolvePlanDetails(input.environment, input.config.plan_name);
            planDisplayName = planInfo.planDisplayName;
            if (planInfo.ram) planSpecs.ram = planInfo.ram;
            if (planInfo.disk) planSpecs.disk = planInfo.disk;
            if (planInfo.cores) planSpecs.cores = planInfo.cores;
          } catch (err) {
            console.warn(`[Deployment Runner] Could not fetch plan details: ${err}`);
            // Continue with defaults
          }
          
          const issueNumber = await createVmApprovalRequest({
            repositoryFullName: `${input.repositoryOwner}/${input.repositoryName}`,
            assignedUsername,
            vmHostname,
            environment: input.environment,
            requestedBy: input.triggeredBy ?? "deployment-bot",
            planName: planDisplayName,
            planDetails: {
              ram: planSpecs.ram,
              disk: planSpecs.disk,
              cores: planSpecs.cores,
              ipPool: input.environment === "dev" ? "Pre-Production VMs" : 
                      input.environment === "stage" ? "Stage VMs" : "Production VMs"
            }
          });
          
          throw new VmApprovalPendingError(`VM approval required. Created issue #${issueNumber} for @${assignedUsername} to review`);
        }
        
        // Status is "approved", proceed with VM creation
        return `VM ${vmHostname} approved, proceeding with creation`;
      },
      "VM approval check complete"
    );

    const vmResult = await runStep(
      deployment.id,
      "virtualizor.ensure_vm",
      async () =>
        ensureVirtualizorVm({
          vmHostname,
          repositoryFullName: `${input.repositoryOwner}/${input.repositoryName}`,
          assignedUsername,
          dryRun: input.dryRun,
          environment: input.environment,
          planName: input.config.plan_name
        }),
      "VM ensured"
    );
    
    // Use VM IP from virtualizor result
    vmIp = vmResult.vmIp;
    console.log(`[Deployment Runner] VM ${vmResult.vmId} at IP ${vmIp}`);

    console.log(`[Deployment Runner] Recording audit event for VM ${vmResult.created ? 'creation' : 'reuse'}...`);
    await recordAuditEvent({
      actorType: "system",
      actorId: input.triggeredBy ?? "unknown",
      action: vmResult.created ? "deployment.vm.created" : "deployment.vm.reused",
      resourceType: "deployment",
      resourceId: String(deployment.id),
      payload: {
        vmHostname: input.config.vm_hostname,
        vmId: vmResult.vmId,
        vmIp: vmResult.vmIp,
        virtualizorMode: appConfig.VIRTUALIZOR_MODE
      }
    });
    console.log(`[Deployment Runner] Audit event recorded, proceeding with secret mappings...`);

    await runStep(deployment.id, "vm.audit_secret_mappings", async () => {
      await auditSecretMappings(deployment.id, input.config.env_mappings, resolvedSecrets.unresolved);
    });

    // Sync authorized admins to VM if configured
    if (input.config.authorized_admins && input.config.authorized_admins.length > 0) {
      console.log(`[Deployment Runner] Syncing authorized admins to VM...`);
      
      await runStep(
        deployment.id,
        "vm.sync_authorized_admins",
        async () => {
          // For org team operations, prefer static token if available (installation tokens may lack org permissions)
          const githubToken = await getGitHubToken(input.repositoryOwner, input.repositoryName, { 
            preferStaticToken: true 
          });
          
          if (!githubToken) {
            throw new Error(
              "GitHub App token is required for authorized_admins feature (needed to resolve smart groups like github.repo.collaborators, github.repo.admins, and github.org.*)"
            );
          }
          
          const result = await syncAuthorizedAdminsToVm({
            repositoryOwner: input.repositoryOwner,
            repositoryName: input.repositoryName,
            vmIp: vmIp!,
            authorizedAdmins: input.config.authorized_admins!,
            githubToken,
            sshUser: appConfig.VM_SSH_USER,
            sshKeyPath: appConfig.VM_SSH_KEY_PATH,
            sshPort: input.config.ssh_port ?? appConfig.VM_SSH_PORT,
            dryRun: input.dryRun
          });
          
          return result;
        },
        (result) => `Processed ${result.usersProcessed} users (created: ${result.usersCreated}, added to group: ${result.usersAddedToGroup}, removed from group: ${result.usersRemovedFromGroup})`
      );
    }

    console.log(`[Deployment Runner] Starting docker compose deployment to VM...`);

    // Resolve docker-compose content (inline or file reference)
    let dockerComposeContent = await resolveFileContent({
      content: input.config.docker_compose,
      configPath: input.configPath,
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      commitSha: input.commitSha
    });

    // Inject Managed Nebula client service
    dockerComposeContent = await injectNebulaClient(dockerComposeContent);

    await runStep(
      deployment.id,
      "vm.deploy_compose",
      async () => {
        return deployComposeToVm({
          vmHostname: input.config.vm_hostname,
          vmIp: vmIp!,
          composeConfig: dockerComposeContent,
          envValues: resolvedSecrets.envValues,
          dryRun: input.dryRun,
          sshUser: appConfig.VM_SSH_USER,
          sshKeyPath: appConfig.VM_SSH_KEY_PATH,
          sshPort: input.config.ssh_port ?? appConfig.VM_SSH_PORT,
          remoteBaseDir: appConfig.VM_DEPLOY_BASE_DIR
        });
      },
      (stdout) => stdout
    );

    vmComposeDeployed = true;

    // Deploy Caddy config from Caddyfile in repository
    let deployedCaddyFiles: string[] = [];
    let caddyfileContent: string | null = null;

    // Try to fetch Caddyfile from repo (same directory as config)
    // Note: Using lowercase 'caddyfile' for Linux compatibility
    const configDir = input.configPath.substring(0, input.configPath.lastIndexOf('/'));
    const caddyfilePath = `${configDir}/caddyfile`;
    
    try {
      caddyfileContent = await fetchFileFromGitHub({
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        path: caddyfilePath,
        ref: input.commitSha
      });
    } catch (error) {
      // Caddyfile not found - skip gracefully
      console.log(`[Deployment Runner] No caddyfile found at ${caddyfilePath}, skipping Caddy deployment`);
      caddyfileContent = null;
    }

    if (caddyfileContent) {
      await runStep(
        deployment.id,
        "caddy.deploy_config",
        async () => {
          // Get Nebula IP from secrets (environment-specific)
          const nebulaIpSecretName = `${input.environment.toUpperCase()}_NEBULA_IP`;
          let nebulaIp: string | null | undefined = resolvedSecrets.envValues[nebulaIpSecretName];
          
          // Fallback: Query Managed Nebula API if secret doesn't exist
          if (!nebulaIp) {
            console.log(`[Deployment Runner] Secret ${nebulaIpSecretName} not found, querying Managed Nebula API...`);
            const apiResult = await getNebulaIpAddress({
              repositoryOwner: input.repositoryOwner,
              repositoryName: input.repositoryName,
              environment: input.environment
            });
            
            if (apiResult) {
              nebulaIp = apiResult;
              console.log(`[Deployment Runner] Retrieved Nebula IP from API: ${nebulaIp}`);
            } else {
              console.log(`[Deployment Runner] No Nebula IP found in API either`);
            }
          }

          // Validate domains in Caddyfile
          const approvedDomains = user.approvedDomains.map((item: { domain: string }) => item.domain);
          const domainErrors = validateCaddyfileDomains({
            caddyfileContent,
            configDomains: input.config.domains,
            approvedDomains
          });

          if (domainErrors.length > 0) {
            throw new Error(`Caddyfile domain validation failed: ${domainErrors.join("; ")}`);
          }

          // Process Caddyfile content (replace placeholders)
          let processed = caddyfileContent;
          processed = processed.replace(/\{\{vm\.ip\}\}/g, vmIp!);
          if (nebulaIp) {
            processed = processed.replace(/\{\{nebula\.ip\}\}/g, nebulaIp);
          }

          // Deploy as single file with naming convention: {owner}-{repo}-{env}.caddy (all lowercase)
          const fileName = `${input.repositoryOwner.toLowerCase()}-${input.repositoryName.toLowerCase()}-${input.environment.toLowerCase()}.caddy`;
          const processedCaddyConfig: Record<string, string> = {
            [fileName]: processed
          };
          
          const result = await deployCaddyConfig({
            caddyHost: input.caddyHost,
            caddyConfig: processedCaddyConfig,
            domains: input.config.domains,
            dryRun: input.dryRun,
            sshUser: appConfig.CADDY_SSH_USER,
            sshKeyPath: appConfig.CADDY_SSH_KEY_PATH,
            sshPort: input.config.caddy_ssh_port ?? appConfig.CADDY_SSH_PORT,
            remoteConfigDir: appConfig.CADDY_CONFIG_DIR,
            validateCommand: appConfig.CADDY_VALIDATE_COMMAND,
            reloadCommand: appConfig.CADDY_RELOAD_COMMAND,
            repositoryOwner: input.repositoryOwner,
            repositoryName: input.repositoryName,
            environment: input.environment
          });
          
          deployedCaddyFiles = result.deployedFiles;
          return result;
        },
        "Caddy configuration deployed successfully"
      );

      await runStep(deployment.id, "caddy.persist_release", async () => {
        await prisma.caddyRelease.create({
          data: {
            deploymentId: deployment.id,
            caddyHost: input.caddyHost,
            configChecksum: createHash("sha256").update(caddyfileContent).digest("hex"),
            reloadStatus: "success",
            deployedFiles: deployedCaddyFiles
          }
        });
      });
    }

    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: "success",
        finishedAt: new Date()
      }
    });

    if (githubDeploymentId !== null) {
      await updateGithubDeploymentStatus({
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        githubDeploymentId,
        state: "success",
        logUrl: deploymentLogUrl(deployment.id)
      });
    }

    // Update commit status to success
    await setDeploymentCommitStatus(input, {
      state: "success",
      description: `Deployed to ${input.environment}`,
      deploymentId: deployment.id
    });

    await recordAuditEvent({
      actorType: "system",
      actorId: input.triggeredBy ?? "unknown",
      action: "deployment.succeeded",
      resourceType: "deployment",
      resourceId: String(deployment.id),
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        environment: input.environment,
        commitSha: input.commitSha
      }
    });

    // Close deployment error issue if one exists for this environment (best-effort)
    if (appConfig.GITHUB_DEPLOYMENT_ERROR_ISSUES_ENABLED) {
      await closeDeploymentErrorIssue({
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        environment: input.environment,
        commitSha: input.commitSha,
        deploymentId: deployment.id,
        logUrl: deploymentLogUrl(deployment.id)
      });
    }

    return { deploymentId: deployment.id };
  } catch (error) {
    // Special handling for VM approval pending - not a real failure
    if (error instanceof VmApprovalPendingError) {
      // Keep deployment in pending state, don't mark as failed
      // The deployment-queue will handle setting job status to "pending_approval"
      throw error;
    }

    // Regular error handling for actual failures
    const compensation = await runCompensationPlan({
      deploymentId: deployment.id,
      vmHostname: input.config.vm_hostname,
      vmIp,
      dryRun: input.dryRun,
      vmComposeDeployed
    });

    await recordAuditEvent({
      actorType: "system",
      actorId: input.triggeredBy ?? "unknown",
      action: "deployment.compensation_completed",
      resourceType: "deployment",
      resourceId: String(deployment.id),
      payload: {
        state: compensation.state,
        attempted: compensation.attempted,
        succeeded: compensation.succeeded,
        failed: compensation.failed,
        actions: compensation.actions,
        errors: compensation.errors
      }
    });

    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: "failed",
        finishedAt: new Date()
      }
    });

    if (githubDeploymentId !== null) {
      await updateGithubDeploymentStatus({
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        githubDeploymentId,
        state: "failure",
        logUrl: deploymentLogUrl(deployment.id),
        description: error instanceof Error ? error.message.slice(0, 140) : "deployment failed"
      });
    }

    // Update commit status to failure
    await setDeploymentCommitStatus(input, {
      state: "failure",
      description: `Deployment to ${input.environment} failed`,
      deploymentId: deployment.id
    });

    await recordAuditEvent({
      actorType: "system",
      actorId: input.triggeredBy ?? "unknown",
      action: "deployment.failed",
      resourceType: "deployment",
      resourceId: String(deployment.id),
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        environment: input.environment,
        commitSha: input.commitSha,
        error: error instanceof Error ? error.message : "unknown error",
        compensationState: compensation.state,
        compensationAttempted: compensation.attempted,
        compensationSucceeded: compensation.succeeded,
        compensationFailed: compensation.failed
      }
    });

    // Report deployment error as GitHub issue (best-effort)
    if (appConfig.GITHUB_DEPLOYMENT_ERROR_ISSUES_ENABLED) {
      await reportDeploymentError({
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        environment: input.environment,
        commitSha: input.commitSha,
        errorMessage: error instanceof Error ? error.message : String(error),
        deploymentId: deployment.id,
        logUrl: deploymentLogUrl(deployment.id)
      });
    }

    throw error;
  }
}
