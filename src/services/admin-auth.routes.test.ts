import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import {
  __setAdminRoleBindingsForTests,
  authorizeAdminRequest,
  type AdminPermission
} from "./admin-auth.js";

const fallbackOwnerToken = "owner-fallback-token";
const operatorToken = "operator-token-123456";
const auditorToken = "auditor-token-123456";

type RouteCase = {
  method: "GET" | "POST";
  url: string;
  permission: AdminPermission;
};

const routeCases: RouteCase[] = [
  { method: "POST", url: "/users-write", permission: "users.write" },
  { method: "POST", url: "/repo-secrets-write", permission: "repositorySecrets.write" },
  { method: "POST", url: "/deploy-execute", permission: "deployments.execute" },
  { method: "GET", url: "/audit-read", permission: "audit.read" },
  { method: "GET", url: "/queue-read", permission: "queue.read" },
  { method: "POST", url: "/rbac-manage", permission: "rbac.manage" }
];

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();

  for (const routeCase of routeCases) {
    const handler = async (request: any, reply: any) => {
      const principal = authorizeAdminRequest({
        request,
        reply,
        fallbackToken: fallbackOwnerToken,
        requiredPermission: routeCase.permission
      });

      if (!principal) {
        return;
      }

      return reply.code(204).send();
    };

    if (routeCase.method === "GET") {
      app.get(routeCase.url, handler);
    } else {
      app.post(routeCase.url, handler);
    }
  }

  await app.ready();
  return app;
}

describe("authorizeAdminRequest integration", () => {
  beforeEach(() => {
    __setAdminRoleBindingsForTests([
      { token: operatorToken, role: "operator" },
      { token: auditorToken, role: "auditor" }
    ]);
  });

  afterEach(() => {
    __setAdminRoleBindingsForTests([]);
  });

  it("enforces route-level allow and deny matrix by role", async () => {
    const app = await buildApp();

    const expectations: Array<{
      role: "owner" | "operator" | "auditor";
      token: string;
      allows: AdminPermission[];
      denies: AdminPermission[];
    }> = [
      {
        role: "owner",
        token: fallbackOwnerToken,
        allows: [
          "users.write",
          "repositorySecrets.write",
          "deployments.execute",
          "audit.read",
          "queue.read",
          "rbac.manage"
        ],
        denies: []
      },
      {
        role: "operator",
        token: operatorToken,
        allows: ["users.write", "deployments.execute", "queue.read"],
        denies: ["repositorySecrets.write", "audit.read", "rbac.manage"]
      },
      {
        role: "auditor",
        token: auditorToken,
        allows: ["audit.read", "queue.read"],
        denies: ["users.write", "repositorySecrets.write", "deployments.execute", "rbac.manage"]
      }
    ];

    for (const expectation of expectations) {
      for (const routeCase of routeCases) {
        const response = await app.inject({
          method: routeCase.method,
          url: routeCase.url,
          headers: {
            "x-admin-token": expectation.token
          }
        });

        if (expectation.allows.includes(routeCase.permission)) {
          assert.equal(
            response.statusCode,
            204,
            `${expectation.role} should be allowed for ${routeCase.permission}`
          );
        }

        if (expectation.denies.includes(routeCase.permission)) {
          assert.equal(
            response.statusCode,
            403,
            `${expectation.role} should be denied for ${routeCase.permission}`
          );
        }
      }
    }

    const unauthorized = await app.inject({
      method: "GET",
      url: "/queue-read"
    });
    assert.equal(unauthorized.statusCode, 401);

    await app.close();
  });
});
