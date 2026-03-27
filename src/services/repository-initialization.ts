/**
 * Repository Initialization Service
 * 
 * Orchestrates automated setup when the bot is installed on a repository:
 * 1. Creates initialization issue
 * 2. Provisions Nebula VPN clients
 * 3. Pushes secrets to GitHub
 * 4. Creates setup branch and PR with sync-secrets workflow
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { appConfig } from "../config.js";
import { recordAuditEvent } from "./audit.js";
import { provisionNebulaClients } from "./nebula-provisioning.js";
import { provisionRepositoryToken } from "./repository-tokens.js";
import {
  createGitHubIssue,
  addGitHubComment,
  createGitHubBranch,
  createOrUpdateGitHubFile,
  createGitHubPullRequest,
  createMultipleFilesInSingleCommit,
  linkIssueToBranch
} from "./github-automation.js";
import { generateSyncSecretsWorkflow } from "./workflow-generator.js";

export interface RepositoryInitializationResult {
  success: boolean;
  issueNumber?: number;
  issueUrl?: string;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}

interface Issue {
  number: number;
  html_url: string;
  node_id: string;
}

interface PullRequest {
  number: number;
  html_url: string;
}

interface ProvisionResult {
  success: boolean;
  environment: string;
  clientName?: string;
  ipAddress?: string;
  error?: string;
}

/**
 * Template: Initial issue body
 */
function getInitializationIssueBody(): string {
  return `## 🤖 KumpeApps Deployment Bot Setup

This issue tracks the automated initialization of the deployment bot for this repository.

### Tasks

- [ ] Provision Nebula VPN clients
- [ ] Push secrets to GitHub
- [ ] Create sync-secrets workflow
- [ ] Create deployment config templates
- [ ] Submit pull request for review

**Note:** This process is fully automated. Please review the pull request when it's ready.`;
}

/**
 * Template: Nebula provisioning request comment
 */
function getNebulaProvisioningRequestComment(input: {
  repositoryOwner: string;
  repositoryName: string;
}): string {
  return `### 🔐 Provisioning Nebula VPN Clients

Creating VPN clients for environments:
- \`dev-${input.repositoryOwner}-${input.repositoryName}\`
- \`stage-${input.repositoryOwner}-${input.repositoryName}\`
- \`prod-${input.repositoryOwner}-${input.repositoryName}\`

Please wait...`;
}

/**
 * Template: Nebula provisioning completion comment
 */
function getNebulaProvisioningCompletionComment(params: {
  nebulaResults: ProvisionResult[];
}): { body: string; nebulaSuccess: boolean; nebulaErrorMessage: string } {
  const failures = params.nebulaResults.filter((r) => !r.success);
  const nebulaSuccess = failures.length === 0;
  const nebulaErrorMessage = failures
    .filter((f) => f.error)
    .map((f) => `${f.environment}: ${f.error}`)
    .join(", ");

  const statusEmoji = nebulaSuccess ? "✅" : "⚠️";
  const statusText = nebulaSuccess
    ? "Successfully provisioned Nebula VPN clients and pushed secrets to GitHub!"
    : "Completed with some errors";

  const environmentsText = params.nebulaResults
    .map((r) =>
      r.success
        ? `- ✅ **${r.environment.toUpperCase()}**: Client \`${r.clientName}\` created with IP \`${r.ipAddress}\``
        : `- ❌ **${r.environment.toUpperCase()}**: ${r.error}`
    )
    .join("\n");

  const secretsText = nebulaSuccess
    ? `- \`KUMPEAPPS_DEPLOY_BOT_TOKEN\`
- \`DEV_NEBULA_CLIENT_TOKEN\` / \`DEV_NEBULA_IP\`
- \`STAGE_NEBULA_CLIENT_TOKEN\` / \`STAGE_NEBULA_IP\`
- \`PROD_NEBULA_CLIENT_TOKEN\` / \`PROD_NEBULA_IP\``
    : "Some secrets may not have been created. Check errors above.";

  const errorsBlock = nebulaSuccess ? "" : `\n**Errors:** ${nebulaErrorMessage}\n`;

  return {
    nebulaSuccess,
    nebulaErrorMessage,
    body: `### ${statusEmoji} Nebula VPN Provisioning ${statusText}

**Environments provisioned:**
${environmentsText}

**GitHub Secrets created:**
${secretsText}

${errorsBlock}Proceeding with workflow setup...`
  };
}

/**
 * Template: Token-only provisioning comment (when Nebula is disabled)
 */
function getTokenOnlyProvisioningComment(): string {
  return `### ✅ Repository Token Provisioned

**GitHub Secrets created:**
- \`KUMPEAPPS_DEPLOY_BOT_TOKEN\`

**Note:** Nebula VPN provisioning is disabled in bot configuration.

Proceeding with workflow setup...`;
}

/**
 * Read environment-specific config templates from files
 */
async function loadEnvironmentTemplates(): Promise<{
  dev: string;
  stage: string;
  prod: string;
  gitleaks: string;
  gitleaksignore: string;
}> {
  const templatesDir = join(process.cwd(), "templates");
  
  const [dev, stage, prod, gitleaks, gitleaksignore] = await Promise.all([
    readFile(join(templatesDir, "dev-example.yml.template"), "utf-8"),
    readFile(join(templatesDir, "stage-example.yml.template"), "utf-8"),
    readFile(join(templatesDir, "prod-example.yml.template"), "utf-8"),
    readFile(join(templatesDir, "gitleaks.toml.template"), "utf-8"),
    readFile(join(templatesDir, "gitleaksignore.template"), "utf-8")
  ]);
  
  return { dev, stage, prod, gitleaks, gitleaksignore };
}

/**
 * Template: Pull request body
 */
function getInitializationPrBody(params: {
  issueNumber: number;
  nebulaEnabled: boolean;
}): string {
  const nebulaWhatIncluded = params.nebulaEnabled
    ? `✅ **Nebula VPN Clients**: Created for dev, stage, and prod environments
✅ **Nebula Secrets**: VPN tokens and IPs added to repository secrets`
    : "";

  const nebulaSecrets = params.nebulaEnabled
    ? `- \`DEV_NEBULA_CLIENT_TOKEN\` / \`DEV_NEBULA_IP\` - Dev environment VPN
- \`STAGE_NEBULA_CLIENT_TOKEN\` / \`STAGE_NEBULA_IP\` - Stage environment VPN
- \`PROD_NEBULA_CLIENT_TOKEN\` / \`PROD_NEBULA_IP\` - Prod environment VPN`
    : "";

  return `## 🤖 Automated Deployment Bot Setup

This PR adds the required GitHub Actions workflow and deployment configuration templates.

### What's included

- \`.github/workflows/sync-secrets.yml\` - Workflow to sync secrets to the bot
- \`.kumpeapps-deploy-bot/dev/dev-example.yml.template\` - Dev environment example (label-based PR deployment)
- \`.kumpeapps-deploy-bot/stage/stage-example.yml.template\` - Stage environment example (main branch deployment)
- \`.kumpeapps-deploy-bot/prod/prod-example.yml.template\` - Prod environment example (release-based deployment)
- \`.gitleaks.toml\` - Secret scanner configuration to prevent false positives
- \`.gitleaksignore\` - Ignore list for template files

### What's been set up

✅ **Repository Token**: \`KUMPEAPPS_DEPLOY_BOT_TOKEN\` secret created
${nebulaWhatIncluded}

### Next steps

1. **Review this PR** - Check the workflow and template configurations
2. **Merge this PR** - This activates the sync-secrets workflow and creates the folder structure
3. **Configure deployments** - Copy and customize the template files:
   \`\`\`bash
   # Example: Create dev environment config
   cp .kumpeapps-deploy-bot/dev/dev-example.yml.template .kumpeapps-deploy-bot/dev/myapp.yml
   \`\`\`
   Then customize with your actual values:
   - Update \`assigned_username\`, \`vm_hostname\`, and \`domains\`
   - Customize \`authorized_admins\` if using VM user management
   - Add your \`docker_compose\` file or inline content
   - Configure \`caddy\` reverse proxy settings
   - Add environment variable mappings in \`env_mappings\`
   - Adjust \`deploy_rules\` for your workflow (labels/branches/releases)
4. **Sync secrets** - Run the sync-secrets workflow to push your secrets to the bot

### Secrets available in workflows

The following secrets are now available in your GitHub Actions workflows:
- \`KUMPEAPPS_DEPLOY_BOT_TOKEN\` - Authentication token for the bot
${nebulaSecrets}

### Documentation

For more information, see the [deployment bot documentation](https://github.com/kumpeapps/kumpeapps-deployment-bot).

---
Closes #${params.issueNumber}`;
}

/**
 * Template: Final setup completion comment
 */
function getFinalSetupComment(params: { prNumber: number }): string {
  return `### 🎉 Setup Complete!

Pull request created: #${params.prNumber}

Please review and merge the pull request to complete the deployment bot setup.`;
}

/**
 * Helper: Create initialization issue and add initial comment
 */
async function createInitializationIssue(input: {
  repositoryOwner: string;
  repositoryName: string;
}): Promise<Issue> {
  const issue = await createGitHubIssue({
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    title: "[task] KumpeApps Deployment Bot Initialization",
    body: getInitializationIssueBody(),
    labels: ["bot", "task"],
    assignees: ["kumpeapps-bot-deploy"]
  });

  await addGitHubComment({
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    issueNumber: issue.number,
    body: getNebulaProvisioningRequestComment(input)
  });

  return issue;
}

/**
 * Helper: Handle Nebula provisioning or token-only setup
 */
async function handleProvisioning(input: {
  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
}): Promise<void> {
  // Provision repository token
  const tokenResult = await provisionRepositoryToken({
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName
  });

  if (!tokenResult.success) {
    throw new Error(`Failed to provision repository token: ${tokenResult.error}`);
  }

  // Handle Nebula provisioning if enabled
  if (appConfig.MANAGED_NEBULA_ENABLED) {
    const nebulaResults = await provisionNebulaClients({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName
    });

    const { body } = getNebulaProvisioningCompletionComment({ nebulaResults });

    await addGitHubComment({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      issueNumber: input.issueNumber,
      body
    });
  } else {
    // Nebula disabled, just note the token was created
    await addGitHubComment({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      issueNumber: input.issueNumber,
      body: getTokenOnlyProvisioningComment()
    });
  }
}

/**
 * Helper: Create workflow branch and generate sync-secrets.yml
 */
async function setupSyncSecretsWorkflowBranch(params: {
  repositoryOwner: string;
  repositoryName: string;
  issue: Issue;
}): Promise<{ branchName: string; pr: PullRequest }> {
  const branchName = `task/#${params.issue.number}`;

  // Create branch
  await createGitHubBranch({
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    branchName
  });

  // Link branch to issue (non-fatal if it fails)
  try {
    await linkIssueToBranch({
      repositoryOwner: params.repositoryOwner,
      repositoryName: params.repositoryName,
      issueNodeId: params.issue.node_id,
      branchName
    });
  } catch (error) {
    console.warn(`Failed to link branch to issue: ${error}`);
  }

  // Prepare all files to be committed in a single commit
  const workflowContent = generateSyncSecretsWorkflow(appConfig.MANAGED_NEBULA_ENABLED);
  const templates = await loadEnvironmentTemplates();

  const files = [
    {
      path: ".github/workflows/sync-secrets.yml",
      content: workflowContent
    },
    {
      path: ".kumpeapps-deploy-bot/dev/dev-example.yml.template",
      content: templates.dev
    },
    {
      path: ".kumpeapps-deploy-bot/stage/stage-example.yml.template",
      content: templates.stage
    },
    {
      path: ".kumpeapps-deploy-bot/prod/prod-example.yml.template",
      content: templates.prod
    },
    {
      path: ".gitleaks.toml",
      content: templates.gitleaks
    },
    {
      path: ".gitleaksignore",
      content: templates.gitleaksignore
    }
  ];

  // Create all files in a single commit
  await createMultipleFilesInSingleCommit({
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    branch: branchName,
    files,
    message: `[${branchName}] chore: initialize deployment bot configuration`
  });

  // Create pull request
  const pr = await createGitHubPullRequest({
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    title: `[bot] Initialize Deployment Bot Configuration`,
    body: getInitializationPrBody({
      issueNumber: params.issue.number,
      nebulaEnabled: appConfig.MANAGED_NEBULA_ENABLED
    }),
    head: branchName,
    assignees: ["kumpeapps-bot-deploy"]
  });

  return { branchName, pr };
}

/**
 * Initialize a newly installed repository with automated setup
 */
export async function initializeRepository(input: {
  repositoryOwner: string;
  repositoryName: string;
}): Promise<RepositoryInitializationResult> {
  try {
    // Step 1: Create initialization issue
    const issue = await createInitializationIssue(input);

    // Step 2: Provision token and optionally Nebula clients
    await handleProvisioning({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      issueNumber: issue.number
    });

    // Step 3: Setup workflow branch and create PR
    const { pr } = await setupSyncSecretsWorkflowBranch({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      issue
    });

    // Step 4: Add final completion comment
    await addGitHubComment({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      issueNumber: issue.number,
      body: getFinalSetupComment({ prNumber: pr.number })
    });

    // Record success audit event
    await recordAuditEvent({
      actorType: "system",
      actorId: "repo-initializer",
      action: "repository.initialized",
      resourceType: "repository",
      resourceId: `${input.repositoryOwner}/${input.repositoryName}`,
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        issueNumber: issue.number,
        prNumber: pr.number,
        nebulaEnabled: appConfig.MANAGED_NEBULA_ENABLED
      }
    });

    return {
      success: true,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      prNumber: pr.number,
      prUrl: pr.html_url
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await recordAuditEvent({
      actorType: "system",
      actorId: "repo-initializer",
      action: "repository.initialization.failed",
      resourceType: "repository",
      resourceId: `${input.repositoryOwner}/${input.repositoryName}`,
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        error: errorMessage
      }
    });

    return {
      success: false,
      error: errorMessage
    };
  }
}
