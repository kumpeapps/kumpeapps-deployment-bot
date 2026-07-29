/**
 * Docker registry auth helpers for VM docker config.json generation.
 */

/** Registries that Docker treats as Docker Hub and expects under this config key. */
const DOCKER_HUB_CONFIG_KEY = "https://index.docker.io/v1/";

const DOCKER_HUB_ALIASES = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
  "https://index.docker.io/v1",
  "https://index.docker.io/v1/",
  "https://registry-1.docker.io",
  "https://registry-1.docker.io/v2/"
]);

/**
 * Normalize a registry hostname/URL to the key Docker looks up in config.json.
 * Docker Hub pulls only use auth when the key is exactly https://index.docker.io/v1/.
 */
export function normalizeDockerRegistryKey(registry: string): string {
  const trimmed = registry.trim();
  if (!trimmed) {
    return trimmed;
  }

  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  const lower = withoutTrailingSlash.toLowerCase();

  if (DOCKER_HUB_ALIASES.has(lower) || DOCKER_HUB_ALIASES.has(`${lower}/`)) {
    return DOCKER_HUB_CONFIG_KEY;
  }

  // Strip scheme for non-Hub registries so ghcr.io and https://ghcr.io both work.
  const host = lower.replace(/^https?:\/\//, "").split("/")[0] ?? lower;
  if (DOCKER_HUB_ALIASES.has(host)) {
    return DOCKER_HUB_CONFIG_KEY;
  }

  return host || trimmed;
}

export function buildDockerConfigContent(
  registryLogins: Array<{ registry: string; username: string; password: string }>
): string {
  const auths: Record<string, { auth: string }> = {};

  for (const login of registryLogins) {
    const key = normalizeDockerRegistryKey(login.registry);
    if (!key) {
      continue;
    }

    auths[key] = {
      auth: Buffer.from(`${login.username}:${login.password}`, "utf8").toString("base64")
    };
  }

  return JSON.stringify({ auths });
}

export { DOCKER_HUB_CONFIG_KEY };
