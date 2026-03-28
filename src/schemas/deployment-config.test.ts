import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeploymentConfigSchema,
  extractDomainsFromCaddyfile,
  isDomainApproved,
  validateDeploymentPolicy,
  validateCaddyfileDomains,
  type DeploymentConfig
} from "./deployment-config.js";

function makeConfig(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    deployment_type: "docker",
    assigned_username: "testuser",
    vm_hostname: "vm.example.com",
    domains: ["app.example.com"],
    docker_compose: "version: '3'",
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

describe("extractDomainsFromCaddyfile", () => {
  it("extracts domain from simple Caddyfile", () => {
    const content = "api.example.com {\n  reverse_proxy localhost:3000\n}";
    const domains = extractDomainsFromCaddyfile(content);
    assert.ok(domains.includes("api.example.com"));
  });

  it("extracts multiple domains from Caddyfile", () => {
    const content = "app.example.com, www.example.com {\n  reverse_proxy localhost:8080\n}";
    const domains = extractDomainsFromCaddyfile(content);
    assert.ok(domains.includes("app.example.com"));
    assert.ok(domains.includes("www.example.com"));
  });

  it("extracts wildcard domains", () => {
    const content = "*.example.com {\n  reverse_proxy localhost:8080\n}";
    const domains = extractDomainsFromCaddyfile(content);
    assert.ok(domains.includes("*.example.com"));
  });

  it("returns empty array for empty content", () => {
    assert.deepEqual(extractDomainsFromCaddyfile(""), []);
  });
});

describe("validateCaddyfileDomains", () => {
  it("accepts when all Caddyfile domains are in config and authorized", () => {
    const errors = validateCaddyfileDomains({
      caddyfileContent: "app.example.com { reverse_proxy :8080 }",
      configDomains: ["app.example.com"],
      approvedDomains: ["*.example.com"]
    });
    assert.deepEqual(errors, []);
  });

  it("rejects when Caddyfile domain not in config", () => {
    const errors = validateCaddyfileDomains({
      caddyfileContent: "other.example.com { reverse_proxy :8080 }",
      configDomains: ["app.example.com"],
      approvedDomains: ["*.example.com"]
    });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes("not declared in config"));
  });

  it("rejects when Caddyfile domain not authorized", () => {
    const errors = validateCaddyfileDomains({
      caddyfileContent: "evil.com { reverse_proxy :8080 }",
      configDomains: ["evil.com"],
      approvedDomains: ["example.com"]
    });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes("not in authorized domains"));
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
      authorizedPlans: [],
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
      authorizedPlans: [],
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
      authorizedPlans: [],
      maxDomains: 5,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.ok(!errors.some((e) => e.includes("assigned_username")));
  });

  it("fails when domain count exceeds maxDomains", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig({
        domains: ["a.example.com", "b.example.com"]
      }),
      approvedDomains: ["a.example.com", "b.example.com"],
      authorizedPlans: [],
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
      authorizedPlans: [],
      maxDomains: 5,
      maxVms: 2,
      currentVmCount: 2
    });
    assert.ok(errors.some((e) => e.includes("maxVms")));
  });

  it("fails when a domain in config is not approved", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig({ domains: ["evil.other.com"] }),
      approvedDomains: ["app.example.com"],
      authorizedPlans: [],
      maxDomains: 5,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.ok(errors.some((e) => e.includes("evil.other.com")));
  });

  it("accepts wildcard-covered subdomains in approved domains", () => {
    const errors = validateDeploymentPolicy({
      config: makeConfig({
        domains: ["sub.example.com"]
      }),
      approvedDomains: ["*.example.com"],
      authorizedPlans: [],
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
      authorizedPlans: [],
      maxDomains: 5,
      maxVms: 3,
      currentVmCount: 0
    });
    assert.deepEqual(errors, []);
  });
});
