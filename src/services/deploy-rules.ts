import type { DeploymentConfig } from "../schemas/deployment-config.js";

export function branchFromRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/**
 * Checks if a branch matches deploy rules for branch-based deployments (push events)
 */
export function matchesDeployRules(config: DeploymentConfig, branch: string, environment: string): boolean {
  const rules = config.deploy_rules.filter((rule) => rule.environment === environment);
  if (rules.length === 0) {
    return false;
  }

  return rules.some((rule) => {
    // If no branches specified, skip branch matching (might be label or release based)
    if (!rule.branches || (rule.branches.include.length === 0 && rule.branches.exclude.length === 0)) {
      return false;
    }

    const included = rule.branches.include.length === 0 || rule.branches.include.includes(branch);
    const excluded = rule.branches.exclude.includes(branch);
    return included && !excluded;
  });
}

/**
 * Checks if deploy rules specify label-based deployment for an environment
 * Returns the list of labels that trigger deployment, or empty array if none
 */
export function getDeployLabels(config: DeploymentConfig, environment: string): string[] {
  const rules = config.deploy_rules.filter((rule) => rule.environment === environment);
  const labels = new Set<string>();

  for (const rule of rules) {
    if (rule.labels && rule.labels.length > 0) {
      for (const label of rule.labels) {
        labels.add(label);
      }
    }
  }

  return Array.from(labels);
}

/**
 * Checks if a release event matches deploy rules for release-based deployments
 */
export function matchesReleaseRules(
  config: DeploymentConfig,
  environment: string,
  releaseType: string,
  isPrerelease: boolean
): boolean {
  const rules = config.deploy_rules.filter((rule) => rule.environment === environment);
  if (rules.length === 0) {
    return false;
  }

  return rules.some((rule) => {
    if (!rule.release) {
      return false;
    }

    // Check if this release type is in the allowed types
    if (!rule.release.types.includes(releaseType as any)) {
      return false;
    }

    // If exclude_prerelease is true and this is a prerelease, don't match
    if (rule.release.exclude_prerelease && isPrerelease) {
      return false;
    }

    return true;
  });
}
