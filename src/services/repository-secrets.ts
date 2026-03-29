import { prisma } from "../db.js";
import { decryptSecretValue } from "./secret-crypto.js";
import { recordSecretDecryptFailure } from "./secret-health.js";
import { fetchGithubRepositorySecrets } from "./github-secrets.js";

export async function resolveRepositoryEnvValues(input: {
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  envMappings: Record<string, string>;
}): Promise<{
  envValues: Record<string, string>;
  unresolved: Array<{ envKey: string; secretName: string }>;
}> {
  const secretNames = Array.from(new Set(Object.values(input.envMappings)));

  const byName = new Map<string, string>();

  // Phase 1: Try to resolve from GitHub API (if enabled)
  const githubSecrets = await fetchGithubRepositorySecrets({
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName
  });

  if (githubSecrets) {
    for (const [secretName, value] of Object.entries(githubSecrets)) {
      if (secretNames.includes(secretName) && value && !value.startsWith("__github_secret_")) {
        byName.set(secretName, value);
      }
    }
  }

  // Phase 2: Fall back to DB-stored secrets for unresolved names
  const missingNames = secretNames.filter((name) => !byName.has(name));
  if (missingNames.length > 0) {
    const secrets = await prisma.repositorySecret.findMany({
      where: {
        repositoryId: input.repositoryId,
        name: { in: missingNames }
      }
    });

    for (const secret of secrets) {
      try {
        byName.set(secret.name, decryptSecretValue(secret.value).trim());
      } catch (error) {
        recordSecretDecryptFailure({
          repositoryId: secret.repositoryId,
          secretName: secret.name,
          reason: error instanceof Error ? error.message : "unknown decrypt error"
        });
      }
    }
  }

  const envValues: Record<string, string> = {};
  const unresolved: Array<{ envKey: string; secretName: string }> = [];

  for (const [envKey, secretName] of Object.entries(input.envMappings)) {
    const value = byName.get(secretName);
    if (value === undefined) {
      unresolved.push({ envKey, secretName });
      continue;
    }

    envValues[envKey] = value;
  }

  return { envValues, unresolved };
}
