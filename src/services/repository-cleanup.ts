import { prisma } from "../db.js";
import { deprovisionNebulaClients, cleanupRepositorySecrets } from "./nebula-provisioning.js";
import { removeRepositoryCollaborator } from "../services/github-automation.js";
import { recordAuditEvent } from "./audit.js";

export async function cleanupRepository(input: {
  owner: string;
  name: string;
  reason: string;
  logger?: { info: (obj: any, msg: string) => void; warn: (obj: any, msg: string) => void };
}): Promise<{
  repository: { id: number } | null;
  deletedConfigs: number;
  deletedSecrets: number;
  nebulaResults: Array<{ environment: string; success: boolean; error?: string }>;
  secretsCleanup: { deleted: number; failed: number };
  collaboratorRemoved: boolean;
}> {
  const logger = input.logger ?? console;

  const repository = await prisma.repository.findUnique({
    where: {
      owner_name: {
        owner: input.owner,
        name: input.name
      }
    }
  });

  if (!repository) {
    logger.warn(
      { owner: input.owner, repo: input.name },
      "Repository not found in database - skipping cleanup"
    );
    return {
      repository: null,
      deletedConfigs: 0,
      deletedSecrets: 0,
      nebulaResults: [],
      secretsCleanup: { deleted: 0, failed: 0 },
      collaboratorRemoved: false
    };
  }

  logger.info(
    { owner: input.owner, repo: input.name, reason: input.reason },
    "Starting repository cleanup"
  );

  // Clean up deployment configs
  const deletedConfigs = await prisma.deploymentConfig.deleteMany({
    where: { repositoryId: repository.id }
  });

  logger.info(
    { owner: input.owner, repo: input.name, count: deletedConfigs.count },
    "Deleted deployment configs"
  );

  // Clean up repository secrets
  const deletedSecrets = await prisma.repositorySecret.deleteMany({
    where: { repositoryId: repository.id }
  });

  logger.info(
    { owner: input.owner, repo: input.name, count: deletedSecrets.count },
    "Deleted repository secrets"
  );

  // Deprovision Nebula clients
  const nebulaResults = await deprovisionNebulaClients({
    repositoryOwner: input.owner,
    repositoryName: input.name
  });

  for (const envResult of nebulaResults) {
    if (envResult.success) {
      logger.info(
        {
          owner: input.owner,
          repo: input.name,
          environment: envResult.environment
        },
        "Nebula VPN client deprovisioned"
      );
    } else {
      logger.warn(
        {
          owner: input.owner,
          repo: input.name,
          environment: envResult.environment,
          error: envResult.error
        },
        "Failed to deprovision Nebula VPN client"
      );
    }
  }

  // Clean up GitHub secrets and variables (using bot user PAT)
  const secretCleanupResult = await cleanupRepositorySecrets({
    repositoryOwner: input.owner,
    repositoryName: input.name
  });

  logger.info(
    {
      owner: input.owner,
      repo: input.name,
      deleted: secretCleanupResult.deleted,
      failed: secretCleanupResult.failed
    },
    "GitHub secrets and variables cleanup completed"
  );

  if (secretCleanupResult.errors.length > 0) {
    logger.warn(
      {
        owner: input.owner,
        repo: input.name,
        errors: secretCleanupResult.errors
      },
      "Some secrets/variables failed to clean up"
    );
  }

  // Remove kumpeapps-bot-deploy from repository collaborators (using bot user PAT)
  const collaboratorRemovalResult = await removeRepositoryCollaborator({
    repositoryOwner: input.owner,
    repositoryName: input.name,
    username: "kumpeapps-bot-deploy"
  });

  if (collaboratorRemovalResult.success) {
    logger.info(
      { owner: input.owner, repo: input.name },
      "Removed kumpeapps-bot-deploy from repository collaborators"
    );
  } else {
    logger.warn(
      {
        owner: input.owner,
        repo: input.name,
        error: collaboratorRemovalResult.error
      },
      "Failed to remove kumpeapps-bot-deploy from collaborators"
    );
  }

  // Clear initialization state (apiToken) so repository can be reinitialized
  await prisma.repository.update({
    where: { id: repository.id },
    data: { apiToken: null }
  } as any);

  logger.info(
    { owner: input.owner, repo: input.name },
    "Cleared repository initialization state"
  );

  // Record audit event
  await recordAuditEvent({
    actorType: "system",
    actorId: "cleanup-service",
    action: "repository.cleanup",
    resourceType: "repository",
    resourceId: `${input.owner}/${input.name}`,
    payload: {
      reason: input.reason,
      deletedConfigs: deletedConfigs.count,
      deletedSecrets: deletedSecrets.count,
      nebulaResults,
      secretsCleanup: {
        deleted: secretCleanupResult.deleted,
        failed: secretCleanupResult.failed,
        errors: secretCleanupResult.errors
      },
      collaboratorRemoved: collaboratorRemovalResult.success
    }
  });

  logger.info(
    { owner: input.owner, repo: input.name, reason: input.reason },
    "Repository cleanup completed"
  );

  return {
    repository: { id: repository.id },
    deletedConfigs: deletedConfigs.count,
    deletedSecrets: deletedSecrets.count,
    nebulaResults,
    secretsCleanup: {
      deleted: secretCleanupResult.deleted,
      failed: secretCleanupResult.failed
    },
    collaboratorRemoved: collaboratorRemovalResult.success
  };
}
