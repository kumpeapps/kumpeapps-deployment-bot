import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authenticateAdminToken, roleAllowsPermission } from "./admin-auth.js";

describe("authenticateAdminToken", () => {
  it("treats legacy ADMIN_API_TOKEN as owner token", () => {
    const principal = authenticateAdminToken("legacy-owner-token", "legacy-owner-token");
    assert.equal(principal?.role, "owner");
  });

  it("rejects unknown token", () => {
    const principal = authenticateAdminToken("nope", "legacy-owner-token");
    assert.equal(principal, null);
  });
});

describe("roleAllowsPermission", () => {
  it("enforces owner/operator/auditor permission boundaries", () => {
    assert.equal(roleAllowsPermission("owner", "rbac.manage"), true);
    assert.equal(roleAllowsPermission("operator", "rbac.manage"), false);
    assert.equal(roleAllowsPermission("auditor", "rbac.manage"), false);

    assert.equal(roleAllowsPermission("owner", "repositorySecrets.write"), true);
    assert.equal(roleAllowsPermission("operator", "repositorySecrets.write"), false);
    assert.equal(roleAllowsPermission("auditor", "repositorySecrets.write"), false);

    assert.equal(roleAllowsPermission("owner", "deployments.execute"), true);
    assert.equal(roleAllowsPermission("operator", "deployments.execute"), true);
    assert.equal(roleAllowsPermission("auditor", "deployments.execute"), false);

    assert.equal(roleAllowsPermission("owner", "audit.read"), true);
    assert.equal(roleAllowsPermission("operator", "audit.read"), false);
    assert.equal(roleAllowsPermission("auditor", "audit.read"), true);
  });
});
