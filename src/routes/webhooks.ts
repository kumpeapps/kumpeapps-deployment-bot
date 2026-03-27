import type { FastifyInstance } from "fastify";
import { Webhooks } from "@octokit/webhooks";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";
import { enqueueDeploymentJob } from "../services/deployment-queue.js";
import { branchFromRef, matchesDeployRules, getDeployLabels, matchesReleaseRules } from "../services/deploy-rules.js";
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
import { addRepositoryCollaborator, acceptRepositoryInvitation } from "../services/github-automation.js";
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

    // Get GitHub token for PR label checking
    const token = await getGitHubToken(owner, name);

    // Fetch open PRs for this branch to check labels
    let openPRsForBranch: Array<{ number: number; labels: Array<{ name: string }> }> = [];
    try {
      const prsResponse = await fetch(
        `https://api.github.com/repos/${owner}/${name}/pulls?state=open&head=${owner}:${branch}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json'
          }
        }
      );

      if (prsResponse.ok) {
        openPRsForBranch = await prsResponse.json() as Array<{ number: number; labels: Array<{ name: string }> }>;
        app.log.info(
          { fullName, branch, prCount: openPRsForBranch.length },
          "Found open PRs for branch"
        );
      }
    } catch (error) {
      app.log.warn({ error, fullName, branch }, "Failed to fetch PRs for branch; continuing with branch-only matching");
    }

    for (const snapshot of configSnapshots) {
      const configParsed = DeploymentConfigSchema.safeParse(snapshot.parsedJson);
      if (!configParsed.success) {
        app.log.warn({ configPath: snapshot.configPath }, "Skipping invalid stored deployment config snapshot");
        continue;
      }

      // Check if this config requires label-based deployment
      const deployLabels = getDeployLabels(configParsed.data, snapshot.environment);
      
      let shouldDeploy = false;
      let deployReason = "";

      if (deployLabels.length > 0) {
        // Label-based deployment: check if any open PR for this branch has required labels
        const prWithLabel = openPRsForBranch.find(pr => 
          pr.labels.some(label => deployLabels.includes(label.name))
        );

        if (prWithLabel) {
          const matchingLabel = prWithLabel.labels.find(l => deployLabels.includes(l.name))?.name;
          
          // Check if branch patterns are also specified
          const ruleForEnv = configParsed.data.deploy_rules.find(r => r.environment === snapshot.environment);
          const hasBranchPatterns = ruleForEnv?.branches && 
            (ruleForEnv.branches.include.length > 0 || ruleForEnv.branches.exclude.length > 0);

          if (hasBranchPatterns && ruleForEnv?.branches) {
            // Both label and branch patterns required
            const included = ruleForEnv.branches.include.length === 0 || 
              ruleForEnv.branches.include.includes(branch);
            const excluded = ruleForEnv.branches.exclude.includes(branch);
            const branchMatches = included && !excluded;

            if (branchMatches) {
              shouldDeploy = true;
              deployReason = `PR #${prWithLabel.number} has label "${matchingLabel}" and branch matches patterns`;
              app.log.info(
                { configPath: snapshot.configPath, environment: snapshot.environment, prNumber: prWithLabel.number, label: matchingLabel, branch },
                "Label-based deployment with branch filtering - condition met"
              );
            } else {
              app.log.info(
                { configPath: snapshot.configPath, environment: snapshot.environment, prNumber: prWithLabel.number, label: matchingLabel, branch },
                "PR has required label but branch does not match patterns; skipping"
              );
            }
          } else {
            // Label only, no branch restrictions
            shouldDeploy = true;
            deployReason = `PR #${prWithLabel.number} has label "${matchingLabel}"`;
            app.log.info(
              { configPath: snapshot.configPath, environment: snapshot.environment, prNumber: prWithLabel.number, label: matchingLabel },
              "Label-based deployment condition met (no branch restrictions)"
            );
          }
        } else {
          app.log.info(
            { configPath: snapshot.configPath, environment: snapshot.environment, branch, requiredLabels: deployLabels },
            "No open PR with required labels; skipping label-based deployment"
          );
        }
      } else {
        // Traditional branch-based deployment
        const matches = matchesDeployRules(configParsed.data, branch, snapshot.environment);
        if (matches) {
          shouldDeploy = true;
          deployReason = "branch matches deploy rules";
          
          app.log.info(
            { configPath: snapshot.configPath, environment: snapshot.environment, branch },
            "Branch-based deployment condition met"
          );
        } else {
          app.log.info(
            { configPath: snapshot.configPath, environment: snapshot.environment, branch },
            "Config deploy rules do not match branch; skipping"
          );
        }
      }

      if (!shouldDeploy) {
        continue;
      }

      app.log.info(
        { 
          configPath: snapshot.configPath, 
          environment: snapshot.environment,
          reason: deployReason,
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

    // Add kumpeapps-bot-deploy as collaborator to each repository
    for (const repo of repositories) {
      try {
        await addRepositoryCollaborator({
          repositoryOwner: repo.owner,
          repositoryName: repo.name,
          username: "kumpeapps-bot-deploy",
          permission: "push"
        });
        app.log.info(
          { owner: repo.owner, repo: repo.name },
          "Added kumpeapps-bot-deploy as collaborator"
        );

        // Auto-accept the invitation (for personal repos where invitation is pending)
        const accepted = await acceptRepositoryInvitation({
          repositoryOwner: repo.owner,
          repositoryName: repo.name
        });
        if (accepted) {
          app.log.info(
            { owner: repo.owner, repo: repo.name },
            "Auto-accepted collaborator invitation for kumpeapps-bot-deploy"
          );
        }
      } catch (error) {
        app.log.warn(
          { owner: repo.owner, repo: repo.name, error },
          "Failed to add kumpeapps-bot-deploy as collaborator"
        );
      }
    }

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
    const installationId = BigInt(payload.installation.id);
    await markInstallationInactive(installationId);
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

    // Add kumpeapps-bot-deploy as collaborator to enable PR/issue management
    for (const repo of repositoriesAdded) {
      try {
        await addRepositoryCollaborator({
          repositoryOwner: repo.owner,
          repositoryName: repo.name,
          username: "kumpeapps-bot-deploy",
          permission: "push"
        });
        app.log.info(
          { owner: repo.owner, repo: repo.name },
          "Added kumpeapps-bot-deploy as collaborator"
        );

        // Auto-accept the invitation (for personal repos where invitation is pending)
        const accepted = await acceptRepositoryInvitation({
          repositoryOwner: repo.owner,
          repositoryName: repo.name
        });
        if (accepted) {
          app.log.info(
            { owner: repo.owner, repo: repo.name },
            "Auto-accepted collaborator invitation for kumpeapps-bot-deploy"
          );
        }
      } catch (error) {
        app.log.warn(
          { owner: repo.owner, repo: repo.name, error: String(error) },
          "Failed to add kumpeapps-bot-deploy as collaborator - continuing initialization"
        );
      }
    }

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

    // Deprovision Nebula VPN clients and clean up secrets for removed repositories
    for (const repo of repositoriesRemoved) {
      // Deprovision Nebula clients
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

  webhooks.on("pull_request.labeled", async ({ payload }: { payload: any }) => {
    if (!appConfig.AUTO_DEPLOY_ENABLED) {
      app.log.info("Auto deploy skipped: AUTO_DEPLOY_ENABLED is false");
      return;
    }

    const fullName = payload.repository.full_name;
    const [owner, name] = fullName.split("/");
    const prNumber = payload.pull_request.number;
    const prHeadRef = payload.pull_request.head.ref;
    const prHeadSha = payload.pull_request.head.sha;
    const labelName = payload.label.name;

    app.log.info(
      { fullName, prNumber, labelName, branch: prHeadRef },
      "Processing pull_request.labeled event"
    );

    if (!owner || !name) {
      app.log.warn({ fullName }, "Skipping label-based deploy due to malformed repository full name");
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
      app.log.info({ fullName }, "Skipping label-based deploy for repository not in control plane");
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
            ref: prHeadSha
          }),
        onRetry: (error, attempt) => {
          app.log.warn(
            { error, fullName, attempt },
            "Config sync failed on PR label; retrying"
          );
        }
      });
      
      app.log.info(
        { fullName, synced: syncResult.synced, skipped: syncResult.skipped, errors: syncResult.errors },
        "Config sync completed on PR label"
      );
    } catch (error) {
      app.log.warn({ error, fullName }, "Config sync failed on PR label; continuing with existing snapshots");
    }

    const configSnapshots = await prisma.deploymentConfig.findMany({
      where: { repositoryId: repository.id }
    });

    if (configSnapshots.length === 0) {
      app.log.info({ fullName }, "No deployment configs found; label-based deploy skipped");
      return;
    }

    // Get GitHub token for API operations
    const token = await getGitHubToken(owner, name);

    // Track which configs match this label
    let deploymentsQueued = 0;

    for (const snapshot of configSnapshots) {
      const configParsed = DeploymentConfigSchema.safeParse(snapshot.parsedJson);
      if (!configParsed.success) {
        app.log.warn({ configPath: snapshot.configPath }, "Skipping invalid stored deployment config snapshot");
        continue;
      }

      const deployLabels = getDeployLabels(configParsed.data, snapshot.environment);
      if (!deployLabels.includes(labelName)) {
        app.log.info(
          { configPath: snapshot.configPath, environment: snapshot.environment, labelName },
          "Label not configured for this deployment config; skipping"
        );
        continue;
      }

      // This config matches the label - queue deployment
      app.log.info(
        { 
          configPath: snapshot.configPath, 
          environment: snapshot.environment,
          prNumber,
          labelName,
          dryRun: appConfig.AUTO_DEPLOY_DRY_RUN
        },
        "Queueing label-based deploy"
      );

      const { jobId } = await enqueueDeploymentJob({
        label: `${owner}/${name}:${snapshot.environment}:${snapshot.configPath}`,
        payload: {
          repositoryOwner: owner,
          repositoryName: name,
          environment: snapshot.environment as "dev" | "stage" | "prod",
          commitSha: prHeadSha,
          triggeredBy: payload.sender.login,
          caddyHost: appConfig.AUTO_DEPLOY_CADDY_HOST,
          configPath: snapshot.configPath,
          config: configParsed.data,
          dryRun: appConfig.AUTO_DEPLOY_DRY_RUN
        },
        timeoutMs: appConfig.DEPLOY_QUEUE_JOB_TIMEOUT_MS
      });

      app.log.info(
        { jobId, configPath: snapshot.configPath, environment: snapshot.environment },
        "Label-based deploy queued"
      );

      deploymentsQueued++;

      // Remove this label from all other open PRs
      try {
        const prsResponse = await fetch(
          `https://api.github.com/repos/${owner}/${name}/pulls?state=open`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json'
            }
          }
        );

        if (prsResponse.ok) {
          const prs = await prsResponse.json() as Array<{ number: number; labels: Array<{ name: string }> }>;
          
          for (const pr of prs) {
            // Skip the current PR
            if (pr.number === prNumber) {
              continue;
            }

            // Check if this PR has the label
            const hasLabel = pr.labels.some(l => l.name === labelName);
            if (hasLabel) {
              app.log.info(
                { prNumber: pr.number, labelName },
                "Removing label from other PR"
              );

              await fetch(
                `https://api.github.com/repos/${owner}/${name}/issues/${pr.number}/labels/${encodeURIComponent(labelName)}`,
                {
                  method: 'DELETE',
                  headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json'
                  }
                }
              );
            }
          }
        }
      } catch (error) {
        app.log.warn(
          { error, labelName },
          "Failed to remove label from other PRs"
        );
      }
    }

    if (deploymentsQueued === 0) {
      app.log.info(
        { fullName, labelName },
        "Label did not match any deployment config rules"
      );
    }
  });

  webhooks.on("release.published", async ({ payload }: { payload: any }) => {
    if (!appConfig.AUTO_DEPLOY_ENABLED) {
      app.log.info("Auto deploy skipped: AUTO_DEPLOY_ENABLED is false");
      return;
    }

    const fullName = payload.repository.full_name;
    const [owner, name] = fullName.split("/");
    const releaseTag = payload.release.tag_name;
    const releaseCommitSha = payload.release.target_commitish;
    const isPrerelease = payload.release.prerelease === true;

    app.log.info(
      { fullName, releaseTag, isPrerelease, commitSha: releaseCommitSha },
      "Processing release.published event"
    );

    if (!owner || !name) {
      app.log.warn({ fullName }, "Skipping release-based deploy due to malformed repository full name");
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
      app.log.info({ fullName }, "Skipping release-based deploy for repository not in control plane");
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
            ref: releaseCommitSha
          }),
        onRetry: (error, attempt) => {
          app.log.warn(
            { error, fullName, attempt },
            "Config sync failed on release; retrying"
          );
        }
      });
      
      app.log.info(
        { fullName, synced: syncResult.synced, skipped: syncResult.skipped, errors: syncResult.errors },
        "Config sync completed on release"
      );
    } catch (error) {
      app.log.warn({ error, fullName }, "Config sync failed on release; continuing with existing snapshots");
    }

    const configSnapshots = await prisma.deploymentConfig.findMany({
      where: { repositoryId: repository.id }
    });

    if (configSnapshots.length === 0) {
      app.log.info({ fullName }, "No deployment configs found; release-based deploy skipped");
      return;
    }

    for (const snapshot of configSnapshots) {
      const configParsed = DeploymentConfigSchema.safeParse(snapshot.parsedJson);
      if (!configParsed.success) {
        app.log.warn({ configPath: snapshot.configPath }, "Skipping invalid stored deployment config snapshot");
        continue;
      }

      const matches = matchesReleaseRules(configParsed.data, snapshot.environment, "published", isPrerelease);
      if (!matches) {
        app.log.info(
          { configPath: snapshot.configPath, environment: snapshot.environment, releaseTag, isPrerelease },
          "Release does not match deploy rules; skipping"
        );
        continue;
      }

      app.log.info(
        { 
          configPath: snapshot.configPath, 
          environment: snapshot.environment,
          releaseTag,
          isPrerelease,
          dryRun: appConfig.AUTO_DEPLOY_DRY_RUN
        },
        "Queueing release-based deploy"
      );

      const { jobId } = await enqueueDeploymentJob({
        label: `${owner}/${name}:${snapshot.environment}:${snapshot.configPath}`,
        payload: {
          repositoryOwner: owner,
          repositoryName: name,
          environment: snapshot.environment as "dev" | "stage" | "prod",
          commitSha: releaseCommitSha,
          triggeredBy: payload.sender.login,
          caddyHost: appConfig.AUTO_DEPLOY_CADDY_HOST,
          configPath: snapshot.configPath,
          config: configParsed.data,
          dryRun: appConfig.AUTO_DEPLOY_DRY_RUN
        },
        timeoutMs: appConfig.DEPLOY_QUEUE_JOB_TIMEOUT_MS
      });

      app.log.info(
        { jobId, configPath: snapshot.configPath, environment: snapshot.environment, releaseTag },
        "Release-based deploy queued"
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
            take: 1,
            include: {
              caddyReleases: {
                orderBy: { createdAt: "desc" },
                take: 1
              }
            }
          });

          if (latestDeployment && latestDeployment.caddyReleases.length > 0) {
            const caddyRelease = latestDeployment.caddyReleases[0];
            const caddyFileNames = caddyRelease.deployedFiles as string[];

            if (caddyFileNames && caddyFileNames.length > 0) {
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
              app.log.info({ vmId: vm.id }, "No Caddy files recorded for cleanup");
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
