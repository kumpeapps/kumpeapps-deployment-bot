import { prisma } from "../db.js";

type RepoInput = {
  owner: string;
  name: string;
  defaultBranch: string;
};

export async function upsertInstallation(input: {
  installationId: bigint;
  accountLogin: string;
  permissionsSnapshot: Record<string, string> | null;
  repositories: RepoInput[];
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.githubInstallation.upsert({
      where: { installationId: input.installationId },
      update: {
        accountLogin: input.accountLogin,
        permissionsSnapshot: input.permissionsSnapshot ?? undefined
      },
      create: {
        installationId: input.installationId,
        accountLogin: input.accountLogin,
        permissionsSnapshot: input.permissionsSnapshot ?? undefined
      }
    });

    for (const repository of input.repositories) {
      // Check if repository exists and was previously initialized
      const existingRepo = await tx.repository.findUnique({
        where: {
          owner_name: {
            owner: repository.owner,
            name: repository.name
          }
        },
        select: { apiToken: true, active: true }
      });

      const wasInitializedButInactive = existingRepo?.apiToken && !existingRepo.active;

      await tx.repository.upsert({
        where: {
          owner_name: {
            owner: repository.owner,
            name: repository.name
          }
        },
        update: {
          installationId: input.installationId,
          defaultBranch: repository.defaultBranch,
          active: true,
          // Clear initialization state if repo was uninstalled and is being reinstalled
          // This prevents ghost state where DB says "initialized" but Nebula clients are gone
          // User can run /bot initialize or /bot reinitialize to properly set up again
          ...(wasInitializedButInactive ? { apiToken: null } : {})
        },
        create: {
          installationId: input.installationId,
          owner: repository.owner,
          name: repository.name,
          defaultBranch: repository.defaultBranch,
          active: true
        }
      });
    }
  });
}

export async function markInstallationInactive(installationId: bigint): Promise<void> {
  await prisma.$transaction([
    prisma.repository.updateMany({
      where: { installationId },
      data: { active: false }
    }),
    prisma.githubInstallation.delete({ where: { installationId } })
  ]);
}

export async function upsertInstallationRepositories(input: {
  installationId: bigint;
  accountLogin?: string;
  repositoriesAdded: RepoInput[];
  repositoriesRemoved: RepoInput[];
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Ensure the installation record exists first to satisfy foreign key constraint
    await tx.githubInstallation.upsert({
      where: { installationId: input.installationId },
      update: input.accountLogin ? { accountLogin: input.accountLogin } : {},
      create: {
        installationId: input.installationId,
        accountLogin: input.accountLogin ?? "unknown"
        // permissionsSnapshot omitted - will default to null
      }
    });

    for (const repository of input.repositoriesAdded) {
      await tx.repository.upsert({
        where: {
          owner_name: {
            owner: repository.owner,
            name: repository.name
          }
        },
        update: {
          installationId: input.installationId,
          defaultBranch: repository.defaultBranch,
          active: true
        },
        create: {
          installationId: input.installationId,
          owner: repository.owner,
          name: repository.name,
          defaultBranch: repository.defaultBranch,
          active: true
        }
      });
    }

    for (const repository of input.repositoriesRemoved) {
      await tx.repository.updateMany({
        where: {
          owner: repository.owner,
          name: repository.name,
          installationId: input.installationId
        },
        data: { active: false }
      });
    }
  });
}
