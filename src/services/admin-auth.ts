import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";
import { getGithubAdminSessionUsername } from "./admin-github-session.js";

export type AdminRole = "owner" | "operator" | "auditor";

export type AdminPermission =
  | "users.read"
  | "users.write"
  | "repositorySecrets.read"
  | "repositorySecrets.write"
  | "repositoryConfigs.sync"
  | "operations.rotateSecrets"
  | "operations.cleanupWebhookDeliveries"
  | "audit.read"
  | "webhookDeliveries.read"
  | "config.validate"
  | "deployments.execute"
  | "deployments.read"
  | "jobs.requeue"
  | "queue.read"
  | "queue.manage"
  | "jobs.cleanup"
  | "rbac.manage"
  | "plans.read"
  | "plans.write";

const permissionByRole: Record<AdminRole, Set<AdminPermission>> = {
  owner: new Set<AdminPermission>([
    "users.read",
    "users.write",
    "repositorySecrets.read",
    "repositorySecrets.write",
    "repositoryConfigs.sync",
    "operations.rotateSecrets",
    "operations.cleanupWebhookDeliveries",
    "audit.read",
    "webhookDeliveries.read",
    "config.validate",
    "deployments.execute",
    "deployments.read",
    "jobs.requeue",
    "queue.read",
    "queue.manage",
    "jobs.cleanup",
    "rbac.manage",
    "plans.read",
    "plans.write"
  ]),
  operator: new Set<AdminPermission>([
    "users.read",
    "users.write",
    "repositorySecrets.read",
    "repositoryConfigs.sync",
    "operations.cleanupWebhookDeliveries",
    "config.validate",
    "deployments.execute",
    "deployments.read",
    "jobs.requeue",
    "queue.read",
    "queue.manage",
    "jobs.cleanup",
    "plans.read",
    "plans.write"
  ]),
  auditor: new Set<AdminPermission>([
    "users.read",
    "repositorySecrets.read",
    "audit.read",
    "webhookDeliveries.read",
    "deployments.read",
    "queue.read",
    "plans.read"
  ])
};

export type AdminPrincipal = {
  role: AdminRole;
  actorId: string;
  source?: "env" | "db" | "session";
};

type BindingCache = {
  role: AdminRole;
  actorId: string;
};

const dbBindingByHash = new Map<string, BindingCache>();

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function extractTokenFromRequest(request: FastifyRequest): string | null {
  const tokenHeader = request.headers["x-admin-token"];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  return token;
}

function tokenForRole(role: AdminRole, fallbackToken: string): string {
  if (role === "owner") {
    return appConfig.ADMIN_API_OWNER_TOKEN || fallbackToken;
  }
  if (role === "operator") {
    return appConfig.ADMIN_API_OPERATOR_TOKEN;
  }
  return appConfig.ADMIN_API_AUDITOR_TOKEN;
}

export function authenticateAdminToken(token: string | null, fallbackToken: string): AdminPrincipal | null {
  if (!token) {
    return null;
  }

  const fromDb = dbBindingByHash.get(tokenHash(token));
  if (fromDb) {
    return {
      role: fromDb.role,
      actorId: fromDb.actorId,
      source: "db"
    };
  }

  for (const role of ["owner", "operator", "auditor"] as const) {
    const expected = tokenForRole(role, fallbackToken);
    if (expected && token === expected) {
      return {
        role,
        actorId: `admin:${role}`,
        source: "env"
      };
    }
  }

  return null;
}

export function isAdminTokenAuthorized(token: string | null, fallbackToken: string): boolean {
  return authenticateAdminToken(token, fallbackToken) !== null;
}

export function authorizeAdminRequest(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  fallbackToken: string;
  requiredPermission: AdminPermission;
}): AdminPrincipal | null {
  const token = extractTokenFromRequest(input.request);
  let principal = authenticateAdminToken(token, input.fallbackToken);

  if (!principal) {
    const githubAdminUsername = getGithubAdminSessionUsername(input.request);
    if (githubAdminUsername) {
      principal = {
        role: "owner",
        actorId: `admin:github:${githubAdminUsername}`,
        source: "session"
      };
    }
  }

  if (!principal) {
    void prisma.auditEvent
      .create({
        data: {
          actorType: "admin",
          actorId: "anonymous",
          action: "authz.denied.unauthorized",
          resourceType: "http_route",
          resourceId: `${input.request.method} ${input.request.url}`,
          payloadJson: {
            requiredPermission: input.requiredPermission,
            tokenPresent: Boolean(token),
            ip: input.request.ip
          }
        }
      })
      .catch(() => {
        // Best effort audit logging for denial events.
      });

    void input.reply.code(401).send({ error: "Unauthorized" });
    return null;
  }

  const allowedPermissions = permissionByRole[principal.role];
  if (!allowedPermissions.has(input.requiredPermission)) {
    void prisma.auditEvent
      .create({
        data: {
          actorType: "admin",
          actorId: principal.actorId,
          action: "authz.denied.forbidden",
          resourceType: "http_route",
          resourceId: `${input.request.method} ${input.request.url}`,
          payloadJson: {
            role: principal.role,
            requiredPermission: input.requiredPermission,
            ip: input.request.ip
          }
        }
      })
      .catch(() => {
        // Best effort audit logging for denial events.
      });

    void input.reply.code(403).send({
      error: "Forbidden",
      role: principal.role,
      requiredPermission: input.requiredPermission
    });
    return null;
  }

  return principal;
}

export function isAdminRequestAuthorized(request: FastifyRequest, fallbackToken: string): boolean {
  const token = extractTokenFromRequest(request);
  if (authenticateAdminToken(token, fallbackToken)) {
    return true;
  }
  return Boolean(getGithubAdminSessionUsername(request));
}

export function roleAllowsPermission(role: AdminRole, permission: AdminPermission): boolean {
  return permissionByRole[role].has(permission);
}

export async function refreshAdminRoleBindingsCache(): Promise<void> {
  dbBindingByHash.clear();
  if (!appConfig.ADMIN_RBAC_DB_BINDINGS_ENABLED) {
    return;
  }

  const rows = await prisma.adminRoleBinding.findMany({
    where: { active: true }
  });

  for (const row of rows) {
    const role = row.role as AdminRole;
    if (role !== "owner" && role !== "operator" && role !== "auditor") {
      continue;
    }

    dbBindingByHash.set(row.tokenHash, {
      role,
      actorId: `admin:${role}:db:${row.id}`
    });
  }
}

export async function bootstrapAdminRoleBindingsFromEnv(fallbackToken: string): Promise<void> {
  if (!appConfig.ADMIN_RBAC_DB_BINDINGS_ENABLED || !appConfig.ADMIN_RBAC_BOOTSTRAP_FROM_ENV) {
    return;
  }

  const items: Array<{ role: AdminRole; token: string; description: string }> = [];
  const ownerToken = appConfig.ADMIN_API_OWNER_TOKEN || fallbackToken;
  if (ownerToken) {
    items.push({ role: "owner", token: ownerToken, description: "Bootstrap owner token" });
  }

  if (appConfig.ADMIN_API_OPERATOR_TOKEN) {
    items.push({ role: "operator", token: appConfig.ADMIN_API_OPERATOR_TOKEN, description: "Bootstrap operator token" });
  }

  if (appConfig.ADMIN_API_AUDITOR_TOKEN) {
    items.push({ role: "auditor", token: appConfig.ADMIN_API_AUDITOR_TOKEN, description: "Bootstrap auditor token" });
  }

  for (const item of items) {
    await prisma.adminRoleBinding.upsert({
      where: { tokenHash: tokenHash(item.token) },
      update: {
        role: item.role,
        active: true,
        description: item.description,
        source: "env"
      },
      create: {
        tokenHash: tokenHash(item.token),
        role: item.role,
        description: item.description,
        source: "env",
        active: true
      }
    });
  }

  await refreshAdminRoleBindingsCache();
}

export async function upsertAdminRoleBinding(input: {
  token: string;
  role: AdminRole;
  description?: string;
  source?: string;
}): Promise<void> {
  await prisma.adminRoleBinding.upsert({
    where: { tokenHash: tokenHash(input.token) },
    update: {
      role: input.role,
      active: true,
      description: input.description,
      source: input.source ?? "manual"
    },
    create: {
      tokenHash: tokenHash(input.token),
      role: input.role,
      description: input.description,
      source: input.source ?? "manual",
      active: true
    }
  });
  await refreshAdminRoleBindingsCache();
}

export async function deactivateAdminRoleBindingByHash(hash: string): Promise<number> {
  const result = await prisma.adminRoleBinding.updateMany({
    where: { tokenHash: hash },
    data: { active: false }
  });
  await refreshAdminRoleBindingsCache();
  return result.count;
}

export async function listAdminRoleBindings(limit = 100): Promise<
  Array<{
    id: number;
    tokenHash: string;
    role: string;
    source: string;
    active: boolean;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  return prisma.adminRoleBinding.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 200))
  });
}

export function __setAdminRoleBindingsForTests(bindings: Array<{ token: string; role: AdminRole }>): void {
  dbBindingByHash.clear();
  for (const binding of bindings) {
    dbBindingByHash.set(tokenHash(binding.token), {
      role: binding.role,
      actorId: `admin:${binding.role}:db:test`
    });
  }
}
