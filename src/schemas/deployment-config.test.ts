import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeploymentConfigSchema,
  extractDomainsFromCaddy,
  isDomainApproved,
  validateDeploymentPolicy,
  type DeploymentConfig
} from "./deployment-config.js";

function makeConfig(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    deployment_type: "docker",
    assigned_username: "testuser",
    vm_hostname: "vm.example.com",
    domains: ["app.example.com"],
    docker_compose: "version: '3'",
    caddy: {
      "app.conf": "app.example.com { reverse_proxy localhost:8080 }"
    },
    env_mappings: {},
    deploy_rules: [{ environment: "dev", branches: { include: ["main"], exclude: [] } }],
    ...overrides
  };
}

describe("isDomainApproved", () => {
  it("matches exact domain", () => {
    assert.ok(isDomainApproved("example.com", ["example.com"]));
  });

  it("rejects unlisted domain", () => {
    assert.ok(!isDomainApproved("other.com", ["example.com"]));
  });

  it("matches subdomain under wildcard", () => {
    assert.ok(isDomainApproved("sub.example.com", ["*.example.com"]));
  });

  it("matches root domain under wildcard", () => {
    assert.ok(isDomainApproved("example.com", ["*.example.com"]));
  });

  it("is case-insensitive", () => {
    assert.ok(isDomainApproved("EXAMPLE.COM", ["example.com"]));
  });

  it("returns false when approved list is empty", () => {
    assert.ok(!isDomainApproved("example.com", []));
  });
});

describe("extractDomainsFromCaddy", () => {
  it("extracts host from a simple caddy block", () => {
    const domains = extractDomainsFromCaddy({
      "app.conf": "app.example.com {\n  reverse_proxy localhost:8080\n}"
    });
    assert.ok(
      domains.includes("app.example.com"),
      `expected app.example.com in ${JSON.stringify(domains)}`
    );
  });

  it("does not include localhost as a domain", () => {
    const domains = extractDomainsFromCaddy({
      "app.conf": "app.example.com {\n  reverse_proxy localhost:8080\n}"
    });
    assert.ok(!domains.some((d) => d.includes("localhost")));
  });

  it("returns empty array for empty caddy config", () => {
    assert.deepEqual(extractDomainsFromCaddy({}), []);
  });
});

describe("DeploymentConfigSchema", () => {
  it("parses a valid config", () => {
    const raw = {
      deployment_type: "docker",
      assigned_username: "alice",
      vm_hostname: "vm.example.com",
      domains: ["app.example.com"],
      docker_compose: "version: '3'",
      caddy: { "app.conf": "app.example.com { }" },
      env_mappings: { DB_PASS: "db-secret" },
      deploy_rules: [{ environment: "prod", branches: { include: ["main"], exclude: [] } }]
    };
    const result = DeploymentConfigSchema.safeParse(raw);
    assert.ok(result.success, JSON.stringify(result));
  });

  it("rejects invalid deployment_type", () => {
    const raw = {
      deployment_type: "k8s",
      assigned_username: "alice",
      vm_hostname: "vm.example.com",
      domains: ["app.example.com"],
      docker_compose: "version: '3'",
      caddy: {},
      env_mappings: {},
      deploy_rules: [{ environment: "dev", branches: { include: [], exclude: [] } }]
    };
    assert.ok(!DeploymentConfigSchema.safeParse(raw).success);
  });

  it("rejects empty domains array", () => {
    const raw = {
      deployment_type: "docker",
      assigned_username: "alice",
      vm_hostname: "vm.example.com",
      domains: [],
      docker_compose: "version: '3'",
      caddy: {},
      env_mappings: {},
      deploy_rules: [{ environment: "dev", branches: { include: [], exclude: [] } }]
    };
    assert.ok(!DeploymentConfigSchema.safeParse(raw).success);
  });
});

describe("validateDeploymentPolicy", () => {
  it("passes with a fully valid config", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig(),
      expectedUsername: "testuser",
      approvedDomains: ["app.example.com"],
      maxDomains: 5,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.deepEqual(errors, []);
  });

  it("fails when assigned_username does not match expectedUsername", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig({ assigned_username: "alice" }),
      expectedUsername: "bob",
      approvedDomains: ["app.example.com"],
      maxDomains: 5,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.ok(errors.some((e) => e.includes("assigned_username")));
  });

  it("skips username check when expectedUsername is omitted", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig({ assigned_username: "alice" }),
      approvedDomains: ["app.example.com"],
      maxDomains: 5,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.ok(!errors.some((e) => e.includes("assigned_username")));
  });

  it("fails when domain count exceeds maxDomains", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig({
        domains: ["a.example.com", "b.example.com"],
        caddy: { "a.conf": "a.example.com { }", "b.conf": "b.example.com { }" }
      }),
      approvedDomains: ["a.example.com", "b.example.com"],
      maxDomains: 1,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.ok(errors.some((e) => e.includes("maxDomains")));
  });

  it("fails when currentVmCount + 1 exceeds maxVms", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig(),
      approvedDomains: ["app.example.com"],
      maxDomains: 5,
      maxVms: 2,
      currentVmCount: 2
    });
    assert.ok(errors.some((e) => e.includes("maxVms")));
  });

  it("fails when a domain in config is not approved", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig({ domains: ["evil.other.com"], caddy: { "e.conf": "evil.other.com { }" } }),
      approvedDomains: ["app.example.com"],
      maxDomains: 5,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.ok(errors.some((e) => e.includes("evil.other.com")));
  });

  it("accepts wildcard-covered subdomains in approved domains", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig({
        domains: ["sub.example.com"],
        caddy: { "sub.conf": "sub.example.com { }" }
      }),
      approvedDomains: ["*.example.com"],
      maxDomains: 5,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.deepEqual(errors, []);
  });

  it("reports no errors without expectedUsername when user matches", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig(),
      approvedDomains: ["app.example.com"],
      maxDomains: 5,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.deepEqual(errors, []);
  });
});
