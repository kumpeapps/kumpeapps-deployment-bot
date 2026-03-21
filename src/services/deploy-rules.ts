import type { DeploymentConfig } from "../schemas/deployment-config.js";

export function branchFromRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export function matchesDeployRules(config: DeploymentConfig, branch: string, environment: string): boolean {
  const rules = config.deploy_rules.filter((rule) => rule.environment === environment);
  if (rules.length === 0) {
    return false;
  }

  return rules.some((rule) => {
    const included = rule.branches.include.length === 0 || rule.branches.include.includes(branch);
    const excluded = rule.branches.exclude.includes(branch);
    return included && !excluded;
  });
}
