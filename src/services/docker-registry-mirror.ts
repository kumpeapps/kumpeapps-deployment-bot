/**
 * Docker Hub / GHCR pull-through mirror helpers (compose image rewrite, auth merge).
 * Daemon.json helpers remain for optional OS-image baking of insecure-registries only;
 * the bot no longer writes daemon.json on VMs (deploy user lacks sudo for /etc/docker).
 */

import {
  DOCKER_HUB_CONFIG_KEY,
  normalizeDockerRegistryKey
} from "./docker-registry-auth.js";

export { DOCKER_HUB_CONFIG_KEY };

export type RegistryLogin = {
  registry: string;
  username: string;
  password: string;
  /** True when this entry came from per-deploy registry_auth rather than bot defaults. */
  overridden?: boolean;
};

export function mirrorUrlToHostPort(mirrorUrl: string): string {
  return mirrorUrl
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export type MergeDockerDaemonJsonInput = {
  existingJson: string;
  hubMirrorUrl?: string;
  ghcrMirrorUrl?: string;
};

/**
 * Merge Hub registry-mirrors and HTTP insecure-registries into daemon.json.
 * Returns changed=false when the effective config is already correct.
 */
export function mergeDockerDaemonJson(input: MergeDockerDaemonJsonInput): {
  content: string;
  changed: boolean;
} {
  let parsed: Record<string, unknown> = {};
  const trimmed = input.existingJson.trim();
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        parsed = {};
      }
    } catch {
      parsed = {};
    }
  }

  const insecure = new Set<string>(
    Array.isArray(parsed["insecure-registries"])
      ? (parsed["insecure-registries"] as unknown[]).map(String)
      : []
  );

  if (input.hubMirrorUrl) {
    const hubUrl = input.hubMirrorUrl.replace(/\/+$/, "");
    parsed["registry-mirrors"] = [hubUrl];
    insecure.add(mirrorUrlToHostPort(hubUrl));
  }

  if (input.ghcrMirrorUrl) {
    insecure.add(mirrorUrlToHostPort(input.ghcrMirrorUrl));
  }

  parsed["insecure-registries"] = uniqueStrings([...insecure]).sort();

  const content = `${JSON.stringify(parsed, null, 2)}\n`;

  const desired = JSON.parse(content) as Record<string, unknown>;
  let existingObj: Record<string, unknown> = {};
  try {
    existingObj = trimmed ? (JSON.parse(trimmed) as Record<string, unknown>) : {};
  } catch {
    existingObj = {};
  }

  const sameMirrors =
    JSON.stringify(desired["registry-mirrors"] ?? null) ===
    JSON.stringify(existingObj["registry-mirrors"] ?? null);
  const sameInsecure =
    JSON.stringify([...(desired["insecure-registries"] as string[])].sort()) ===
    JSON.stringify(
      Array.isArray(existingObj["insecure-registries"])
        ? [...(existingObj["insecure-registries"] as string[])].sort()
        : []
    );

  return { content, changed: !(sameMirrors && sameInsecure) };
}

/**
 * Rewrite ghcr.io/ORG/IMAGE refs to MIRROR/ORG/IMAGE (YAML image: lines and quoted forms).
 */
export function rewriteGhcrImageRefs(
  composeYaml: string,
  mirrorHostPort: string
): { content: string; rewrittenCount: number } {
  const hostPort = mirrorUrlToHostPort(mirrorHostPort);
  let rewrittenCount = 0;
  const content = composeYaml.replace(
    /(image:\s*["']?)ghcr\.io\/([^\s"']+)/gi,
    (_match, prefix: string, path: string) => {
      rewrittenCount += 1;
      return `${prefix}${hostPort}/${path}`;
    }
  );
  return { content, rewrittenCount };
}

/**
 * First path component is a non-Hub registry host if it contains '.' or ':' or is localhost,
 * except docker.io which is Docker Hub and should be rewritten to the Hub cache.
 */
function imageRefHasNonHubRegistryHost(imageRef: string): boolean {
  const withoutDigest = imageRef.split("@")[0] ?? imageRef;
  const firstSlash = withoutDigest.indexOf("/");
  const firstComponent =
    firstSlash === -1 ? withoutDigest.split(":")[0]! : withoutDigest.slice(0, firstSlash);
  if (firstComponent.toLowerCase() === "docker.io") {
    return false;
  }
  return firstComponent.includes(".") || firstComponent.includes(":") || firstComponent === "localhost";
}

/**
 * Map a Docker Hub image name to the pull-through cache path.
 * Official images become library/<name>. Strips docker.io/ prefix.
 */
export function hubImageToCachePath(imageRef: string): string {
  const atIdx = imageRef.indexOf("@");
  const digestSuffix = atIdx >= 0 ? imageRef.slice(atIdx) : "";
  const withoutDigest = atIdx >= 0 ? imageRef.slice(0, atIdx) : imageRef;

  let name = withoutDigest;
  let tagSuffix = "";
  const colonIdx = withoutDigest.lastIndexOf(":");
  const lastSlash = withoutDigest.lastIndexOf("/");
  if (colonIdx > lastSlash) {
    name = withoutDigest.slice(0, colonIdx);
    tagSuffix = withoutDigest.slice(colonIdx);
  }

  let path = name.replace(/^docker\.io\//i, "");
  if (!path.includes("/")) {
    path = `library/${path}`;
  }
  return `${path}${tagSuffix}${digestSuffix}`;
}

/**
 * Rewrite Docker Hub image refs (busybox, user/app, docker.io/...) to HUB_MIRROR/path.
 * Leaves explicit non-Hub registries (ghcr.io, quay.io, host:port, …) untouched.
 */
export function rewriteHubImageRefs(
  composeYaml: string,
  mirrorHostPort: string
): { content: string; rewrittenCount: number } {
  const hostPort = mirrorUrlToHostPort(mirrorHostPort);
  let rewrittenCount = 0;
  const content = composeYaml.replace(
    /(image:\s*["']?)([^\s"']+)/gi,
    (match, prefix: string, imageRef: string) => {
      if (imageRefHasNonHubRegistryHost(imageRef)) {
        return match;
      }
      rewrittenCount += 1;
      return `${prefix}${hostPort}/${hubImageToCachePath(imageRef)}`;
    }
  );
  return { content, rewrittenCount };
}

export type MergeRegistryLoginsInput = {
  botDefaults: Array<{ registry: string; username: string; password: string }>;
  deployOverrides: Array<{ registry: string; username: string; password: string }>;
};

/**
 * Bot-level Hub/GHCR defaults, overridden per registry by deploy registry_auth.
 * Returned registry keys are normalized (Hub → https://index.docker.io/v1/).
 */
export function mergeRegistryLogins(input: MergeRegistryLoginsInput): RegistryLogin[] {
  const byKey = new Map<string, RegistryLogin>();

  for (const login of input.botDefaults) {
    const key = normalizeDockerRegistryKey(login.registry);
    if (!key || !login.username || !login.password) continue;
    byKey.set(key, {
      registry: key,
      username: login.username,
      password: login.password,
      overridden: false
    });
  }

  for (const login of input.deployOverrides) {
    const key = normalizeDockerRegistryKey(login.registry);
    if (!key || !login.username || !login.password) continue;
    byKey.set(key, {
      registry: key,
      username: login.username,
      password: login.password,
      overridden: true
    });
  }

  return [...byKey.values()];
}

/** True when deploy config overrode ghcr.io (skip LAN rewrite so override creds hit real GHCR). */
export function shouldSkipGhcrRewrite(logins: RegistryLogin[]): boolean {
  return logins.some((l) => l.registry === "ghcr.io" && l.overridden);
}

/** True when deploy config overrode Docker Hub (skip LAN rewrite so override creds hit real Hub). */
export function shouldSkipHubRewrite(logins: RegistryLogin[]): boolean {
  return logins.some((l) => l.registry === DOCKER_HUB_CONFIG_KEY && l.overridden);
}

/**
 * Parse `docker info --format '{{json .RegistryConfig}}'` output into insecure registry hosts.
 * Used to gate compose rewrites so existing VMs without insecure-registries keep pulling upstream.
 */
export function insecureRegistryHostsFromDockerInfo(registryConfigJson: string): Set<string> {
  const hosts = new Set<string>();
  try {
    const cfg = JSON.parse(registryConfigJson) as {
      IndexConfigs?: Record<string, { Secure?: boolean } | null>;
    };
    for (const [name, conf] of Object.entries(cfg.IndexConfigs ?? {})) {
      if (conf && conf.Secure === false) {
        hosts.add(name.toLowerCase());
      }
    }
  } catch {
    return hosts;
  }
  return hosts;
}

/** Whether a mirror URL's host:port is listed as an insecure registry on the VM. */
export function isMirrorHostAllowed(mirrorUrl: string, insecureHosts: Set<string>): boolean {
  if (!mirrorUrl.trim()) return false;
  return insecureHosts.has(mirrorUrlToHostPort(mirrorUrl).toLowerCase());
}

/** Read registry-mirrors list from `docker info --format '{{json .RegistryConfig}}'`. */
export function registryMirrorsFromDockerInfo(registryConfigJson: string): string[] {
  try {
    const cfg = JSON.parse(registryConfigJson) as { Mirrors?: unknown };
    if (!Array.isArray(cfg.Mirrors)) return [];
    return cfg.Mirrors.map(String);
  } catch {
    return [];
  }
}

/**
 * Hub pull-through only works via daemon registry-mirrors (not direct host:port pulls).
 * Compare configured mirrors to DOCKER_HUB_MIRROR_URL.
 */
export function isHubRegistryMirrorConfigured(hubMirrorUrl: string, mirrors: string[]): boolean {
  if (!hubMirrorUrl.trim() || mirrors.length === 0) return false;
  const wantHost = mirrorUrlToHostPort(hubMirrorUrl).toLowerCase();
  const wantUrl = hubMirrorUrl.replace(/\/+$/, "").toLowerCase();
  return mirrors.some((m) => {
    const normalized = m.replace(/\/+$/, "").toLowerCase();
    return normalized === wantUrl || mirrorUrlToHostPort(m).toLowerCase() === wantHost;
  });
}
