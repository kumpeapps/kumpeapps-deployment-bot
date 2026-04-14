import { z } from "zod";

const DeployEnvironmentSchema = z.enum(["dev", "stage", "prod"]);

const RegistryAuthSchema = z.object({
  registry: z.string().min(1),
  username_env: z.string().min(1),
  password_env: z.string().min(1)
});

export const DeployRulesSchema = z.object({
  environment: DeployEnvironmentSchema,
  branches: z.object({
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([])
  }).default({ include: [], exclude: [] }).optional(),
  labels: z.array(z.string().min(1)).optional(), // When PR receives one of these labels, deploy and remove from other PRs
  release: z.object({
    types: z.array(z.enum(["published", "created", "released", "edited"])).default(["published"]),
    exclude_prerelease: z.boolean().default(false)
  }).optional()
});

export const DeploymentConfigSchema = z.object({
  deployment_type: z.literal("docker"),
  assigned_username: z.string().min(1).max(255),
  vm_hostname: z.string().min(1).max(255),
  plan_name: z.string().min(1).max(255).optional(),
  domains: z.array(z.string().min(1).max(255)).min(1),
  docker_compose: z.string().min(1),
  env_mappings: z.record(z.string().min(1), z.string().min(1)),
  registry_auth: z.array(RegistryAuthSchema).optional(),
  deploy_rules: z.array(DeployRulesSchema).min(1),
  ssh_port: z.number().int().positive().optional(), // Optional SSH port override for VM
  caddy_ssh_port: z.number().int().positive().optional(), // Optional SSH port override for Caddy server
  authorized_admins: z.array(z.string().min(1)).optional() // Optional list of admin usernames or smart groups (e.g., "github.repo.collaborators")
});

export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/**
 * Extract domains from a single Caddyfile content string
 */
export function extractDomainsFromCaddyfile(caddyfileContent: string): string[] {
  const hostPattern = /(^|\s)(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}(?=\s|\{|$)/gim;
  const domains = new Set<string>();

  const matches = caddyfileContent.match(hostPattern) ?? [];
  for (const match of matches) {
    domains.add(normalizeDomain(match.trim()));
  }

  return Array.from(domains);
}

export function isDomainApproved(domain: string, approvedDomains: string[]): boolean {
  const normalizedDomain = normalizeDomain(domain);

  for (const approvedDomain of approvedDomains.map(normalizeDomain)) {
    if (approvedDomain.startsWith("*.")) {
      const base = approvedDomain.slice(2);
      if (normalizedDomain === base || normalizedDomain.endsWith(`.${base}`)) {
        return true;
      }
      continue;
    }

    if (normalizedDomain === approvedDomain) {
      return true;
    }
  }

  return false;
}

export function validateDeploymentPolicy(input: {
  config: DeploymentConfig;
  expectedUsername?: string;
  approvedDomains: string[];
  authorizedPlans: string[];
  maxDomains: number;
  maxVms: number;
  currentVmCount: number;
}): string[] {
  const errors: string[] = [];
  const configDomains = Array.from(new Set(input.config.domains.map(normalizeDomain)));

  if (input.expectedUsername) {
    const expected = input.expectedUsername.trim().toLowerCase();
    const assigned = input.config.assigned_username.trim().toLowerCase();
    if (assigned !== expected) {
      errors.push("assigned_username does not match expected user");
    }
  }

  if (configDomains.length > input.maxDomains) {
    errors.push("domains exceed user maxDomains limit");
  }

  if (input.currentVmCount + 1 > input.maxVms) {
    errors.push("vm request exceeds user maxVms limit");
  }

  // Validate plan_name if provided and user has plan restrictions
  if (input.config.plan_name && input.authorizedPlans.length > 0) {
    if (!input.authorizedPlans.includes(input.config.plan_name)) {
      errors.push(`plan '${input.config.plan_name}' is not in user's authorized plans`);
    }
  }

  for (const domain of configDomains) {
    if (!isDomainApproved(domain, input.approvedDomains)) {
      errors.push(`domain ${domain} is not in user's approved domains`);
    }
  }

  return errors;
}

/**
 * Validate that domains in Caddyfile match config domains and are authorized
 * Returns array of error messages (empty if valid)
 */
export function validateCaddyfileDomains(input: {
  caddyfileContent: string;
  configDomains: string[];
  approvedDomains: string[];
}): string[] {
  const errors: string[] = [];
  const caddyDomains = extractDomainsFromCaddyfile(input.caddyfileContent);
  const normalizedConfigDomains = input.configDomains.map(normalizeDomain);

  // Check that each Caddyfile domain is declared in config
  for (const caddyDomain of caddyDomains) {
    if (!normalizedConfigDomains.includes(caddyDomain)) {
      errors.push(`Caddyfile contains domain '${caddyDomain}' which is not declared in config domains`);
    }
  }

  // Check that each Caddyfile domain is authorized
  for (const caddyDomain of caddyDomains) {
    if (!isDomainApproved(caddyDomain, input.approvedDomains)) {
      errors.push(`Caddyfile contains domain '${caddyDomain}' which is not in authorized domains`);
    }
  }

  return errors;
}
