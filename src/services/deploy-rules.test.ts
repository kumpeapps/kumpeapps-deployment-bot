import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { branchFromRef, matchesDeployRules } from "./deploy-rules.js";
import type { DeploymentConfig } from "../schemas/deployment-config.js";

function makeConfig(deployRules: DeploymentConfig["deploy_rules"]): DeploymentConfig {
  return {
    deployment_type: "docker",
    assigned_username: "testuser",
    vm_hostname: "vm.example.com",
    domains: ["app.example.com"],
    docker_compose: "version: '3'",
    caddy: {},
    env_mappings: {},
    deploy_rules: deployRules
  };
}

describe("branchFromRef", () => {
  it("strips refs/heads/ prefix", () => {
    assert.equal(branchFromRef("refs/heads/main"), "main");
  });

  it("returns the string unchanged when there is no prefix", () => {
    assert.equal(branchFromRef("main"), "main");
  });

  it("handles feature branch names with slashes", () => {
    assert.equal(branchFromRef("refs/heads/feature/my-branch"), "feature/my-branch");
  });

  it("does not strip refs/tags/ prefix (non-branch ref)", () => {
    assert.equal(branchFromRef("refs/tags/v1.0.0"), "refs/tags/v1.0.0");
  });

  it("handles empty string without throwing", () => {
    assert.equal(branchFromRef(""), "");
  });
});

describe("matchesDeployRules", () => {
  it("returns false when there are no rules for the given environment", () => {
    const config = makeConfig([
      { environment: "prod", branches: { include: ["main"], exclude: [] } }
    ]);
    assert.equal(matchesDeployRules(config, "main", "dev"), false);
  });

  it("matches any branch when include list is empty", () => {
    const config = makeConfig([
      { environment: "dev", branches: { include: [], exclude: [] } }
    ]);
    assert.equal(matchesDeployRules(config, "any-branch-name", "dev"), true);
  });

  it("matches a branch that is in the include list", () => {
    const config = makeConfig([
      { environment: "dev", branches: { include: ["main", "develop"], exclude: [] } }
    ]);
    assert.equal(matchesDeployRules(config, "develop", "dev"), true);
  });

  it("does not match a branch that is not in the include list", () => {
    const config = makeConfig([
      { environment: "dev", branches: { include: ["main"], exclude: [] } }
    ]);
    assert.equal(matchesDeployRules(config, "feature-x", "dev"), false);
  });

  it("excludes a branch even if it appears in the include list", () => {
    const config = makeConfig([
      { environment: "dev", branches: { include: ["main"], exclude: ["main"] } }
    ]);
    assert.equal(matchesDeployRules(config, "main", "dev"), false);
  });

  it("excludes a branch (with empty include = any) in the exclude list", () => {
    const config = makeConfig([
      { environment: "stage", branches: { include: [], exclude: ["hotfix"] } }
    ]);
    assert.equal(matchesDeployRules(config, "hotfix", "stage"), false);
    assert.equal(matchesDeployRules(config, "main", "stage"), true);
  });

  it("returns true if any matching rule allows the branch", () => {
    const config = makeConfig([
      { environment: "dev", branches: { include: ["main"], exclude: [] } },
      { environment: "dev", branches: { include: ["feature"], exclude: [] } }
    ]);
    assert.equal(matchesDeployRules(config, "feature", "dev"), true);
  });

  it("correctly matches prod rules independently from dev rules", () => {
    const config = makeConfig([
      { environment: "dev", branches: { include: ["develop"], exclude: [] } },
      { environment: "prod", branches: { include: ["main"], exclude: [] } }
    ]);
    assert.equal(matchesDeployRules(config, "main", "prod"), true);
    assert.equal(matchesDeployRules(config, "main", "dev"), false);
  });
});
