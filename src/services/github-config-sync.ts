import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";
import { DeploymentConfigSchema } from "../schemas/deployment-config.js";
import { getGitHubToken } from "./github-app-auth.js";

type GitTreeResponse = {
  tree?: Array<{
    path: string;
    type: string;
  }>;
};

type GitContentResponse = {
  content?: string;
  encoding?: string;
};

async function authHeaders(repositoryOwner: string, repositoryName: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "kumpeapps-deployment-bot"
  };

  const token = await getGitHubToken(repositoryOwner, repositoryName);
  if (token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function fetchJson<T>(url: string, repositoryOwner: string, repositoryName: string): Promise<T> {
  const response = await fetch(url, {
    headers: await authHeaders(repositoryOwner, repositoryName)
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
  }

  return (await response.json()) as T;
}

function environmentFromPath(path: string): "dev" | "stage" | "prod" | null {
  if (path.startsWith(".kumpeapps-deploy-bot/dev/")) {
    return "dev";
  }
  if (path.startsWith(".kumpeapps-deploy-bot/stage/")) {
    return "stage";
  }
  if (path.startsWith(".kumpeapps-deploy-bot/prod/")) {
    return "prod";
  }

  return null;
}

function isTemplateConfigPath(path: string): boolean {
  const lowerPath = path.toLowerCase();

  // Ignore the new template naming pattern and any legacy template/example files.
  if (lowerPath.endsWith(".template") || lowerPath.endsWith(".template.yml") || lowerPath.endsWith(".template.yaml")) {
    return true;
  }

  const fileName = lowerPath.split("/").pop() ?? "";
  if (fileName === "template.yml" || fileName === "template.yaml") {
    return true;
  }

  if (fileName.includes("example")) {
    return true;
  }

  return false;
}

export async function syncRepositoryDeploymentConfigs(input: {
  repositoryOwner: string;
  repositoryName: string;
  ref: string;
}): Promise<{
  synced: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}> {
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

  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/git/trees/${encodeURIComponent(input.ref)}?recursive=1`;
  const tree = await fetchJson<GitTreeResponse>(treeUrl, input.repositoryOwner, input.repositoryName);

  const candidates = (tree.tree ?? []).filter((entry) => {
    if (entry.type !== "blob") {
      return false;
    }

    if (!entry.path.startsWith(".kumpeapps-deploy-bot/")) {
      return false;
    }

    if (isTemplateConfigPath(entry.path)) {
      return false;
    }

    return entry.path.endsWith(".yml") || entry.path.endsWith(".yaml");
  });

  let synced = 0;
  let skipped = 0;
  const errors: Array<{ path: string; error: string }> = [];

  for (const entry of candidates) {
    const environment = environmentFromPath(entry.path);
    if (!environment) {
      skipped += 1;
      continue;
    }

    try {
      const contentUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/contents/${encodeURIComponent(entry.path)}?ref=${encodeURIComponent(input.ref)}`;
      const content = await fetchJson<GitContentResponse>(contentUrl, input.repositoryOwner, input.repositoryName);

      if (!content.content || content.encoding !== "base64") {
        throw new Error("GitHub content payload missing base64 content");
      }

      const yamlText = Buffer.from(content.content, "base64").toString("utf8");
      const parsed = parseYaml(yamlText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Config YAML does not parse to an object");
      }

      const validated = DeploymentConfigSchema.parse(parsed);
      const configHash = createHash("sha256").update(JSON.stringify(validated)).digest("hex");

      await prisma.deploymentConfig.upsert({
        where: {
          repositoryId_environment_configPath: {
            repositoryId: repository.id,
            environment,
            configPath: entry.path
          }
        },
        update: {
          configHash,
          parsedJson: validated,
          lastSeenCommitSha: input.ref
        },
        create: {
          repositoryId: repository.id,
          environment,
          configPath: entry.path,
          configHash,
          parsedJson: validated,
          lastSeenCommitSha: input.ref
        }
      });

      synced += 1;
    } catch (error) {
      errors.push({
        path: entry.path,
        error: error instanceof Error ? error.message : "unknown error"
      });
    }
  }

  return {
    synced,
    skipped,
    errors
  };
}
