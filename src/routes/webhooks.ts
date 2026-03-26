import type { FastifyInstance } from "fastify";
import { Webhooks } from "@octokit/webhooks";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";
import { enqueueDeploymentJob } from "../services/deployment-queue.js";
import { branchFromRef, matchesDeployRules } from "../services/deploy-rules.js";
import { syncRepositoryDeploymentConfigs } from "../services/github-config-sync.js";
import { DeploymentConfigSchema } from "../schemas/deployment-config.js";
import {
  markInstallationInactive,
  upsertInstallation,
  upsertInstallationRepositories
} from "../services/installations.js";
import { provisionRepositoryToken } from "../services/repository-tokens.js";
import { provisionNebulaClients, deprovisionNebulaClients, revokeNebulaCertificate } from "../services/nebula-provisioning.js";
import { initializeRepository } from "../services/repository-initialization.js";
import { recordInvalidWebhookSignature } from "../services/webhook-security-health.js";
import { processApprovalComment } from "../services/vm-approval.js";
import { removeCaddyConfig } from "../services/ssh-deployer.js";
import { getGitHubToken } from "../services/github-app-auth.js";

function splitFullName(fullName: string): { owner: string; name: string } {
  const [owner, name] = fullName.split("/");
  return { owner: owner ?? "", name: name ?? fullName };
}

function installationAccountLogin(account: unknown): string {
  if (account && typeof account === "object" && "login" in account) {
    const login = (account as { login?: unknown }).login;
    if (typeof login === "string" && login.length > 0) {
      return login;
    }
  }

  if (account && typeof account === "object" && "slug" in account) {
    const slug = (account as { slug?: unknown }).slug;
    if (typeof slug === "string" && slug.length > 0) {
      return slug;
    }
  }

  return "unknown";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff<T>(input: {
  attempts: number;
  baseDelayMs: number;
  run: () => Promise<T>;
  onRetry: (error: unknown, attempt: number) => void;
}): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= input.attempts; attempt += 1) {
    try {
      return await input.run();
    } catch (error) {
      lastError = error;
      if (attempt >= input.attempts) {
        break;
      }

      input.onRetry(error, attempt + 1);
      await sleep(input.baseDelayMs * Math.pow(2, attempt));
    }
  }

  throw lastError;
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  options: { webhookSecret: string }
): Promise<void> {
  const webhooks = new Webhooks({ secret: options.webhookSecret });
  const receiveWebhook = webhooks.receive.bind(webhooks) as (input: {
    id: string;
    name: string;
    payload: string;
  }) => Promise<void>;

  webhooks.on("push", async ({ payload }: { payload: any }) => {
    if (!appConfig.AUTO_DEPLOY_ENABLED) {
      app.log.info("Auto deploy skipped: AUTO_DEPLOY_ENABLED is false");
      return;
    }

    const fullName = payload.repository.full_name;
    const [owner, name] = fullName.split("/");
    const branch = branchFromRef(payload.ref);

    app.log.info(
      { fullName, branch, commitSha: payload.after },
      "Processing push for auto-deployment"
    );

    if (!owner || !name) {
      app.log.warn({ fullName }, "Skipping auto deploy due to malformed repository full name");
      return;
    }

    const repository = await prisma.repository.findUnique({
      where: {
        owner_name: {
          owner,
          name
        }
      }
    });

    if (!repository) {
      app.log.info({ fullName }, "Skipping auto deploy for repository not in control plane");
      return;
    }

    try {
      const syncResult = await retryWithBackoff({
        attempts: appConfig.WEBHOOK_SYNC_RETRY_ATTEMPTS,
        baseDelayMs: appConfig.WEBHOOK_SYNC_RETRY_BASE_DELAY_MS,
        run: async () =>
          syncRepositoryDeploymentConfigs({
            repositoryOwner: owner,
            repositoryName: name,
            ref: payload.after
          }),
        onRetry: (error, attempt) => {
          app.log.warn(
            { error, fullName, attempt },
            "Config sync failed on push; retrying"
          );
        }
      });
      
      app.log.info(
        { fullName, synced: syncResult.synced, skipped: syncResult.skipped, errors: syncResult.errors },
        "Config sync completed on push"
      );
    } catch (error) {
      app.log.warn({ error, fullName }, "Config sync failed on push; continuing with existing snapshots");
    }

    const configSnapshots = await prisma.deploymentConfig.findMany({
      where: { repositoryId: repository.id }
    });

    app.log.info(
      { fullName, configCount: configSnapshots.length },
      "Found deployment configs for repository"
    );

    if (configSnapshots.length === 0) {
      app.log.info({ fullName }, "No deployment configs found; auto-deploy skipped");
      return;
    }

    for (const snapshot of configSnapshots) {
      const configParsed = DeploymentConfigSchema.safeParse(snapshot.parsedJson);
      if (!configParsed.success) {
        app.log.warn({ configPath: snapshot.configPath }, "Skipping invalid stored deployment config snapshot");
        continue;
      }

      const matches = matchesDeployRules(configParsed.data, branch, snapshot.environment);
      if (!matches) {
        app.log.info(
          { configPath: snapshot.configPath, environment: snapshot.environment, branch },
          "Config deploy rules do not match branch; skipping"
        );
        continue;
      }

      app.log.info(
        { 
          configPath: snapshot.configPath, 
          environment: snapshot.environment,
          dryRun: appConfig.AUTO_DEPLOY_DRY_RUN,
          virtualizorMode: appConfig.VIRTUALIZOR_MODE
        },
        "Queueing auto deploy with config"
      );

      const { jobId } = await enqueueDeploymentJob({
        label: `${owner}/${name}:${snapshot.environment}:${snapshot.configPath}`,
        payload: {
          repositoryOwner: owner,
          repositoryName: name,
          environment: snapshot.environment as "dev" | "stage" | "prod",
          commitSha: payload.after,
          triggeredBy: payload.pusher.name,
          caddyHost: appConfig.AUTO_DEPLOY_CADDY_HOST,
          configPath: snapshot.configPath,
          config: configParsed.data,
          dryRun: appConfig.AUTO_DEPLOY_DRY_RUN
        },
        timeoutMs: appConfig.DEPLOY_QUEUE_JOB_TIMEOUT_MS
      });

      app.log.info(
        { jobId, configPath: snapshot.configPath, environment: snapshot.environment },
        "Auto deploy queued"
      );
    }
  });

  webhooks.on("ping", async ({ payload }: { payload: any }) => {
    app.log.info({ zen: payload.zen }, "Received GitHub ping");
  });

  webhooks.on("installation.created", async ({ payload }: { payload: any }) => {
    const repositories = (payload.repositories ?? []).map((repo: any) => {
      const names = splitFullName(repo.full_name);
      return {
        owner: names.owner,
        name: names.name,
        defaultBranch: "main"
      };
    });

    await upsertInstallation({
      installationId: BigInt(payload.installation.id),
      accountLogin: installationAccountLogin(payload.installation.account),
      permissionsSnapshot: payload.installation.permissions ?? null,
      repositories
    });

    // Initialize each repository with automated setup
    for (const repo of repositories) {
      const result = await initializeRepository({
        repositoryOwner: repo.owner,
        repositoryName: repo.name
      });

      if (result.success) {
        app.log.info(
          { 
            owner: repo.owner, 
            repo: repo.name,
            issueNumber: result.issueNumber,
            prNumber: result.prNumber
          },
          "Repository initialized successfully"
        );
      } else {
        app.log.error(
          { owner: repo.owner, repo: repo.name, error: result.error },
          "Failed to initialize repository"
        );
      }
    }
  });

  webhooks.on("installation.deleted", async ({ payload }: { payload: any }) => {
    await markInstallationInactive(BigInt(payload.installation.id));
  });

  webhooks.on("installation_repositories.added", async ({ payload }: { payload: any }) => {
    const repositoriesAdded = payload.repositories_added.map((repo: any) => {
      const names = splitFullName(repo.full_name);
      return {
        owner: names.owner,
        name: names.name,
        defaultBranch: "main"
      };
    });

    await upsertInstallationRepositories({
      installationId: BigInt(payload.installation.id),
      accountLogin: installationAccountLogin(payload.installation.account),
      repositoriesAdded,
      repositoriesRemoved: []
    });

    // Initialize each newly added repository with automated setup
    for (const repo of repositoriesAdded) {
      const result = await initializeRepository({
        repositoryOwner: repo.owner,
        repositoryName: repo.name
      });

      if (result.success) {
        app.log.info(
          { 
            owner: repo.owner, 
            repo: repo.name,
            issueNumber: result.issueNumber,
            prNumber: result.prNumber
          },
          "Repository initialized successfully"
        );
      } else {
        app.log.error(
          { owner: repo.owner, repo: repo.name, error: result.error },
          "Failed to initialize repository"
        );
      }
    }
  });

  webhooks.on("installation_repositories.removed", async ({ payload }: { payload: any }) => {
    const repositoriesRemoved = payload.repositories_removed.map((repo: any) => {
      const names = splitFullName(repo.full_name);
      return {
        owner: names.owner,
        name: names.name,
        defaultBranch: "main"
      };
    });

    await upsertInstallationRepositories({
      installationId: BigInt(payload.installation.id),
      accountLogin: installationAccountLogin(payload.installation.account),
      repositoriesAdded: [],
      repositoriesRemoved
    });

    // Deprovision Nebula VPN clients for removed repositories
    for (const repo of repositoriesRemoved) {
      const nebulaResults = await deprovisionNebulaClients({
        repositoryOwner: repo.owner,
        repositoryName: repo.name
      });

      for (const envResult of nebulaResults) {
        if (envResult.success) {
          app.log.info(
            { 
              owner: repo.owner, 
              repo: repo.name, 
              environment: envResult.environment
            },
            "Nebula VPN client deprovisioned"
          );
        } else {
          app.log.warn(
            { 
              owner: repo.owner, 
              repo: repo.name, 
              environment: envResult.environment,
              error: envResult.error
            },
            "Failed to deprovision Nebula VPN client"
          );
        }
      }
    }
  });

  webhooks.on("issue_comment", async ({ payload }: { payload: any }) => {
    // Only process newly created comments
    if (payload.action !== "created") {
      return;
    }

    const repositoryFullName = payload.repository.full_name;
    const [owner, name] = repositoryFullName.split('/');
    const issueNumber = payload.issue.number;
    const commentAuthor = payload.comment.user.login;
    const commentBody = payload.comment.body;

    app.log.info(
      { repositoryFullName, issueNumber, commentAuthor },
      "Processing issue comment"
    );

    // Handle /redeploy commands (all variants)
    const redeployMatch = commentBody.trim().toLowerCase().match(/^\/redeploy(?:-(dev|stage|prod))?$/);
    if (redeployMatch) {
      const targetEnvironment = redeployMatch[1] as "dev" | "stage" | "prod" | undefined;
      
      try {
        // Check if commenter is a collaborator
        const token = await getGitHubToken(owner, name);
        const collaboratorResponse = await fetch(
          `https://api.github.com/repos/${owner}/${name}/collaborators/${commentAuthor}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json'
            }
          }
        );

        if (collaboratorResponse.status !== 204) {
          app.log.warn(
            { commentAuthor, repositoryFullName },
            "Non-collaborator attempted /redeploy command"
          );
          
          // Comment on issue to inform user
          await fetch(
            `https://api.github.com/repos/${owner}/${name}/issues/${issueNumber}/comments`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                body: `@${commentAuthor} Only repository collaborators can use the \`/redeploy\` command.`
              })
            }
          );
          return;
        }

        // Get default branch and latest commit
        const repoResponse = await fetch(
          `https://api.github.com/repos/${owner}/${name}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json'
            }
          }
        );

        if (!repoResponse.ok) {
          throw new Error(`Failed to fetch repository details: ${repoResponse.status}`);
        }

        const repoData = await repoResponse.json() as { default_branch: string };
        const defaultBranch = repoData.default_branch;

        // Get latest commit from default branch
        const commitResponse = await fetch(
          `https://api.github.com/repos/${owner}/${name}/commits/${defaultBranch}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json'
            }
          }
        );

        if (!commitResponse.ok) {
          throw new Error(`Failed to fetch latest commit: ${commitResponse.status}`);
        }

        const commitData = await commitResponse.json() as { sha: string };
        const latestCommitSha = commitData.sha;

        app.log.info(
          { repositoryFullName, defaultBranch, commitSha: latestCommitSha, triggeredBy: commentAuthor, targetEnvironment },
          "Redeploying latest commit via /redeploy command"
        );

        // Queue deployment jobs for all or specific deployment configs
        const repository = await prisma.repository.findUnique({
          where: { owner_name: { owner, name } }
        });

        if (!repository) {
          throw new Error(`Repository ${repositoryFullName} not found in database`);
        }

        const deploymentConfigs = await prisma.deploymentConfig.findMany({
          where: {
            repositoryId: repository.id,
            ...(targetEnvironment ? { environment: targetEnvironment } : {})
          }
        });

        if (deploymentConfigs.length === 0) {
          const envMsg = targetEnvironment ? ` for ${targetEnvironment} environment` : '';
          await fetch(
            `https://api.github.com/repos/${owner}/${name}/issues/${issueNumber}/comments`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                body: `@${commentAuthor} No deployment configurations found${envMsg}.`
              })
            }
          );
          return;
        }

        const queuedJobs = [];
        for (const config of deploymentConfigs) {
          const { jobId } = await enqueueDeploymentJob({
            label: `${owner}/${name}:${config.environment}:${config.configPath}`,
            payload: {
              repositoryOwner: owner,
              repositoryName: name,
              environment: config.environment as "dev" | "stage" | "prod",
              commitSha: latestCommitSha,
              triggeredBy: commentAuthor,
              caddyHost: appConfig.AUTO_DEPLOY_CADDY_HOST,
              configPath: config.configPath,
              config: config.parsedJson as any, // DeploymentConfig type
              dryRun: false
            }
          });
          queuedJobs.push({ environment: config.environment, jobId });
        }

        // Comment with success message
        const jobList = queuedJobs.map(j => `- **${j.environment}**: Job #${j.jobId}`).join('\n');
        const envSuffix = targetEnvironment ? ` to ${targetEnvironment}` : '';
        await fetch(
          `https://api.github.com/repos/${owner}/${name}/issues/${issueNumber}/comments`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              body: `✅ **Redeploy Triggered${envSuffix}**\n\n@${commentAuthor} queued deployment of commit \`${latestCommitSha.slice(0, 7)}\` from \`${defaultBranch}\` branch:\n\n${jobList}`
            })
          }
        );

        app.log.info(
          { repositoryFullName, queuedJobs, triggeredBy: commentAuthor },
          "Successfully queued redeploy jobs"
        );

        return;
      } catch (error) {
        app.log.error(
          { error, repositoryFullName, issueNumber },
          "Failed to process /redeploy command"
        );
        return;
      }
    }

    // Handle /approve command (VM approval)
    try {
      const result = await processApprovalComment({
        repositoryFullName,
        issueNumber,
        commentAuthor,
        commentBody
      });

      if (result.approved) {
        app.log.info({ issueNumber, repositoryFullName }, result.message);
      } else {
        app.log.debug({ issueNumber, repositoryFullName }, result.message);
      }
    } catch (error) {
      app.log.error(
        { error, repositoryFullName, issueNumber },
        "Failed to process VM approval comment"
      );
    }
  });

  webhooks.onAny(async ({ id, name, payload }: { id: string; name: string; payload: any }) => {
    const installationId =
      payload && typeof payload === "object" && "installation" in payload
        ? ((payload as { installation?: { id?: number } }).installation?.id ?? null)
        : null;
    const repositoryFullName =
      payload && typeof payload === "object" && "repository" in payload
        ? ((payload as { repository?: { full_name?: string } }).repository?.full_name ?? null)
        : null;

    app.log.info(
      {
        deliveryId: id,
        event: name,
        installationId,
        repository: repositoryFullName
      },
      "Received GitHub webhook"
    );
  });

  app.post("/github/webhook", async (request, reply) => {
    const eventName = request.headers["x-github-event"];
    const signature = request.headers["x-hub-signature-256"];
    const deliveryId = request.headers["x-github-delivery"];

    if (!eventName || !signature || !deliveryId) {
      return reply.code(400).send({ error: "Missing required GitHub headers" });
    }

    const payload = request.body;
    const payloadText = typeof payload === "string" ? payload : JSON.stringify(payload);
    const payloadObject = typeof payload === "string" ? JSON.parse(payload) : payload;

    const signatureValid = await webhooks.verify(payloadText, String(signature));
    if (!signatureValid) {
      recordInvalidWebhookSignature();
      app.log.warn({ deliveryId: String(deliveryId) }, "Rejected invalid GitHub webhook signature");
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }

    const existing = await prisma.githubWebhookDelivery.findUnique({
      where: { deliveryId: String(deliveryId) },
      select: { id: true, processStatus: true, lastAttemptAt: true }
    });

    const inProgressIsStale =
      existing?.processStatus === "in_progress" &&
      Date.now() - existing.lastAttemptAt.getTime() > appConfig.WEBHOOK_DELIVERY_IN_PROGRESS_LEASE_MS;

    if (existing?.processStatus === "processed" || (existing?.processStatus === "in_progress" && !inProgressIsStale)) {
      await prisma.githubWebhookDelivery.update({
        where: { id: existing.id },
        data: {
          duplicateCount: { increment: 1 },
          lastAttemptAt: new Date()
        }
      });

      app.log.info(
        { deliveryId: String(deliveryId), event: String(eventName), status: existing.processStatus },
        "Duplicate GitHub webhook suppressed"
      );
      return reply.code(202).send({ accepted: true, duplicate: true });
    }

    if (inProgressIsStale) {
      app.log.warn(
        { deliveryId: String(deliveryId), event: String(eventName), lastAttemptAt: existing?.lastAttemptAt.toISOString() },
        "Reclaiming stale in-progress webhook delivery"
      );
    }

    if (!existing) {
      await prisma.githubWebhookDelivery.create({
        data: {
          deliveryId: String(deliveryId),
          eventName: String(eventName),
          processStatus: "in_progress"
        }
      });
    } else {
      await prisma.githubWebhookDelivery.update({
        where: { id: existing.id },
        data: {
          eventName: String(eventName),
          processStatus: "in_progress",
          attemptsCount: { increment: 1 },
          staleReclaims: inProgressIsStale ? { increment: 1 } : undefined,
          errorMessage: null,
          lastAttemptAt: new Date()
        }
      });
    }

    try {
      await receiveWebhook({
        id: String(deliveryId),
        name: String(eventName),
        payload: payloadObject
      });

      await prisma.githubWebhookDelivery.update({
        where: { deliveryId: String(deliveryId) },
        data: {
          processStatus: "processed",
          processedAt: new Date(),
          errorMessage: null,
          lastAttemptAt: new Date()
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error 
        ? `${error.message}\n${error.stack ?? ""}` 
        : String(error);
      
      await prisma.githubWebhookDelivery.update({
        where: { deliveryId: String(deliveryId) },
        data: {
          processStatus: "failed",
          errorMessage: errorMessage.slice(0, 1000), // Limit length
          lastAttemptAt: new Date()
        }
      });

      app.log.error(
        { 
          deliveryId: String(deliveryId), 
          eventName: String(eventName),
          errorMessage,
          errorType: error?.constructor?.name ?? typeof error
        }, 
        "Webhook processing failed"
      );
      return reply.code(500).send({ error: "Webhook processing failed" });
    }

    return reply.code(202).send({ accepted: true });
  });

  // Virtualizor VM deletion webhook
  app.post("/virtualizor/webhook/vm-deleted", async (request, reply) => {
    const authHeader = request.headers.authorization as string | undefined;
    const providedSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (!appConfig.VIRTUALIZOR_WEBHOOK_SECRET || providedSecret !== appConfig.VIRTUALIZOR_WEBHOOK_SECRET) {
      app.log.warn({ headers: request.headers }, "Rejected unauthorized Virtualizor webhook");
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const payload = request.body as Record<string, unknown>;
    const virtualizorVmId = payload.vpsid ? String(payload.vpsid) : payload.virtualizorVmId ? String(payload.virtualizorVmId) : null;

    if (!virtualizorVmId) {
      app.log.warn({ payload }, "Virtualizor webhook missing VM ID");
      return reply.code(400).send({ error: "Missing VM ID (vpsid or virtualizorVmId)" });
    }

    app.log.info({ virtualizorVmId, payload }, "Processing Virtualizor VM deletion webhook");

    try {
      const vm = await prisma.vm.findFirst({
        where: { virtualizorVmId },
        include: {
          repository: { select: { id: true, owner: true, name: true } }
        }
      });

      if (!vm) {
        app.log.warn({ virtualizorVmId }, "VM not found in database, ignoring deletion webhook");
        return reply.send({ acknowledged: true, found: false });
      }

      const vmMetadata = vm.metadata as { environment?: string; ip?: string } | null;
      const environment = vmMetadata?.environment;
      const deletionResult = {
        vmId: vm.id,
        repository: `${vm.repository.owner}/${vm.repository.name}`,
        vmHostname: vm.vmHostname,
        caddyCleanup: null as string | null
      };

      // Cleanup Caddy configs if we know the environment
      if (environment) {
        try {
          // Find the latest successful deployment for this repository + environment
          const latestDeployment = await prisma.deployment.findFirst({
            where: {
              repositoryId: vm.repository.id,
              environment,
              status: "success"
            },
            orderBy: { finishedAt: "desc" },
            take: 1
          });

          if (latestDeployment) {
            // Get the deployment config to extract Caddy file names
            const deploymentConfig = await prisma.deploymentConfig.findFirst({
              where: {
                repositoryId: vm.repository.id,
                environment
              },
              orderBy: { updatedAt: "desc" },
              take: 1
            });

            if (deploymentConfig?.parsedJson) {
              const config = deploymentConfig.parsedJson as {
                caddy?: Record<string, string>;
              };

              if (config.caddy && Object.keys(config.caddy).length > 0) {
                const caddyFileNames = Object.keys(config.caddy);
                
                app.log.info(
                  {
                    vmId: vm.id,
                    environment,
                    caddyFiles: caddyFileNames
                  },
                  "Removing Caddy config files for deleted VM"
                );

                const cleanupResult = await removeCaddyConfig({
                  caddyHost: appConfig.AUTO_DEPLOY_CADDY_HOST,
                  fileNames: caddyFileNames,
                  sshUser: appConfig.CADDY_SSH_USER,
                  sshKeyPath: appConfig.CADDY_SSH_KEY_PATH,
                  sshPort: appConfig.CADDY_SSH_PORT,
                  remoteConfigDir: appConfig.CADDY_CONFIG_DIR,
                  reloadCommand: appConfig.CADDY_RELOAD_COMMAND
                });

                deletionResult.caddyCleanup = cleanupResult;
                app.log.info({ vmId: vm.id, result: cleanupResult }, "Caddy config cleanup completed");
              } else {
                app.log.info({ vmId: vm.id }, "No Caddy config found for this deployment");
              }
            }
          } else {
            app.log.info(
              { repositoryId: vm.repository.id, environment },
              "No successful deployment found for Caddy cleanup"
            );
          }
        } catch (caddyError) {
          // Log but don't fail the VM deletion if Caddy cleanup fails
          app.log.error(
            { error: caddyError, vmId: vm.id, environment },
            "Failed to cleanup Caddy config, continuing with VM deletion"
          );
          deletionResult.caddyCleanup = `Error: ${caddyError instanceof Error ? caddyError.message : "Unknown error"}`;
        }
      } else {
        app.log.warn({ vmId: vm.id }, "VM metadata missing environment, skipping Caddy cleanup");
      }

      // Revoke Nebula certificate for this environment
      if (environment) {
        try {
          const nebulaResult = await revokeNebulaCertificate({
            repositoryOwner: vm.repository.owner,
            repositoryName: vm.repository.name,
            environment: environment as "dev" | "stage" | "prod"
          });

          if (nebulaResult.success) {
            app.log.info(
              {
                vmId: vm.id,
                environment,
                repository: `${vm.repository.owner}/${vm.repository.name}`
              },
              "Nebula certificate revoked for deleted VM"
            );
          } else {
            app.log.warn(
              { vmId: vm.id, environment, error: nebulaResult.error },
              "Failed to revoke Nebula certificate"
            );
          }
        } catch (nebulaError) {
          // Log but don't fail the VM deletion if Nebula cert revocation fails
          app.log.error(
            { error: nebulaError, vmId: vm.id, environment },
            "Failed to revoke Nebula certificate, continuing with VM deletion"
          );
        }
      }

      // Invalidate VM approval so new approval is required for next VM creation
      const approvalUpdate = await prisma.vmApprovalRequest.updateMany({
        where: {
          repositoryId: vm.repository.id,
          vmHostname: vm.vmHostname,
          status: { in: ["pending", "approved"] }
        },
        data: {
          status: "cancelled"
        }
      });

      if (approvalUpdate.count > 0) {
        app.log.info(
          { vmHostname: vm.vmHostname, count: approvalUpdate.count },
          "Cancelled VM approval(s) - new approval required for next VM creation"
        );
      }

      // Delete the VM from database
      await prisma.vm.delete({
        where: { id: vm.id }
      });

      app.log.info(
        {
          vmId: vm.id,
          virtualizorVmId,
          repository: deletionResult.repository,
          vmHostname: vm.vmHostname,
          caddyCleanup: deletionResult.caddyCleanup,
          approvalsCancelled: approvalUpdate.count
        },
        "VM deleted from database via Virtualizor webhook"
      );

      return reply.send({
        acknowledged: true,
        found: true,
        deleted: deletionResult
      });
    } catch (error) {
      app.log.error({ error, virtualizorVmId }, "Failed to process VM deletion webhook");
      return reply.code(500).send({ error: "Failed to process deletion" });
    }
  });
}
