import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { recordAuditEvent } from "../services/audit.js";
import { authorizeAdminRequest } from "../services/admin-auth.js";

const RegisterSchema = z.object({
  githubUsername: z.string().min(1).max(255)
});

const ApproveSchema = z.object({
  maxDomains: z.number().int().nonnegative(),
  maxVms: z.number().int().nonnegative(),
  approvedDomains: z.array(z.string().min(1).max(255)).default([])
});

const UserParamsSchema = z.object({ githubUsername: z.string().min(1).max(255) });

const UpdatePolicySchema = z.object({
  maxDomains: z.number().int().nonnegative().optional(),
  maxVms: z.number().int().nonnegative().optional(),
  approvedDomains: z.array(z.string().min(1).max(255)).optional()
});

const UsersListQuerySchema = z.object({
  status: z.enum(["pending", "approved", "suspended"]).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100)
});

function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export async function registerUserRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  app.get("/api/admin/users", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "users.read"
      })
    ) {
      return;
    }

    const queryParsed = UsersListQuerySchema.safeParse(request.query ?? {});
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    const users = await prisma.user.findMany({
      where: {
        status: queryParsed.data.status
      },
      include: {
        limits: true,
        approvedDomains: {
          orderBy: { domain: "asc" }
        }
      },
      orderBy: { createdAt: "desc" },
      take: queryParsed.data.limit
    });

    return reply.send({
      count: users.length,
      users: users.map((user) => ({
        id: user.id,
        githubUsername: user.githubUsername,
        status: user.status,
        createdAt: user.createdAt,
        limits: user.limits,
        approvedDomains: user.approvedDomains.map((item: { domain: string }) => item.domain)
      }))
    });
  });

  app.post("/api/register", async (request, reply) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", issues: parsed.error.issues });
    }

    const githubUsername = normalizeUsername(parsed.data.githubUsername);

    const user = await prisma.user.upsert({
      where: { githubUsername },
      update: {},
      create: {
        githubUsername,
        status: "pending"
      }
    });

    await recordAuditEvent({
      actorType: "user",
      actorId: user.githubUsername,
      action: "user.registered",
      resourceType: "user",
      resourceId: String(user.id),
      payload: {
        githubUsername: user.githubUsername,
        status: user.status
      }
    });

    return reply.code(201).send({
      githubUsername: user.githubUsername,
      status: user.status
    });
  });

  app.post("/api/admin/users/:githubUsername/approve", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "users.write"
    });
    if (!principal) {
      return;
    }

    const paramsParsed = UserParamsSchema.safeParse(request.params);
    const bodyParsed = ApproveSchema.safeParse(request.body);

    if (!paramsParsed.success || !bodyParsed.success) {
      return reply.code(400).send({
        error: "Invalid request",
        paramsIssues: paramsParsed.success ? [] : paramsParsed.error.issues,
        bodyIssues: bodyParsed.success ? [] : bodyParsed.error.issues
      });
    }

    const githubUsername = normalizeUsername(paramsParsed.data.githubUsername);
    const approvedDomains = Array.from(
      new Set(bodyParsed.data.approvedDomains.map((domain) => domain.trim().toLowerCase()))
    );

    const user = await prisma.user.upsert({
      where: { githubUsername },
      update: { status: "approved" },
      create: {
        githubUsername,
        status: "approved"
      }
    });

    await prisma.$transaction([
      prisma.userLimit.upsert({
        where: { userId: user.id },
        update: {
          maxDomains: bodyParsed.data.maxDomains,
          maxVms: bodyParsed.data.maxVms
        },
        create: {
          userId: user.id,
          maxDomains: bodyParsed.data.maxDomains,
          maxVms: bodyParsed.data.maxVms
        }
      }),
      prisma.approvedDomain.deleteMany({ where: { userId: user.id } }),
      ...approvedDomains.map((domain) =>
        prisma.approvedDomain.create({
          data: {
            userId: user.id,
            domain,
            isWildcard: domain.startsWith("*.")
          }
        })
      )
    ]);

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "user.approved",
      resourceType: "user",
      resourceId: String(user.id),
      payload: {
        githubUsername: user.githubUsername,
        maxDomains: bodyParsed.data.maxDomains,
        maxVms: bodyParsed.data.maxVms,
        approvedDomains
      }
    });

    return reply.send({
      githubUsername: user.githubUsername,
      status: "approved",
      limits: {
        maxDomains: bodyParsed.data.maxDomains,
        maxVms: bodyParsed.data.maxVms
      },
      approvedDomains
    });
  });

  app.get("/api/admin/users/:githubUsername", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "users.read"
      })
    ) {
      return;
    }

    const paramsParsed = UserParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid params", issues: paramsParsed.error.issues });
    }

    const githubUsername = normalizeUsername(paramsParsed.data.githubUsername);
    const user = await prisma.user.findUnique({
      where: { githubUsername },
      include: {
        limits: true,
        approvedDomains: {
          orderBy: { domain: "asc" }
        }
      }
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.send({
      user: {
        id: user.id,
        githubUsername: user.githubUsername,
        status: user.status,
        limits: user.limits,
        approvedDomains: user.approvedDomains.map((item: { domain: string }) => item.domain)
      }
    });
  });

  app.put("/api/admin/users/:githubUsername/policy", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "users.write"
    });
    if (!principal) {
      return;
    }

    const paramsParsed = UserParamsSchema.safeParse(request.params);
    const bodyParsed = UpdatePolicySchema.safeParse(request.body ?? {});
    if (!paramsParsed.success || !bodyParsed.success) {
      return reply.code(400).send({
        error: "Invalid request",
        paramsIssues: paramsParsed.success ? [] : paramsParsed.error.issues,
        bodyIssues: bodyParsed.success ? [] : bodyParsed.error.issues
      });
    }

    if (
      bodyParsed.data.maxDomains === undefined &&
      bodyParsed.data.maxVms === undefined &&
      bodyParsed.data.approvedDomains === undefined
    ) {
      return reply.code(400).send({ error: "At least one policy field must be provided" });
    }

    const githubUsername = normalizeUsername(paramsParsed.data.githubUsername);
    const user = await prisma.user.findUnique({ where: { githubUsername } });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    const domains =
      bodyParsed.data.approvedDomains === undefined
        ? undefined
        : Array.from(new Set(bodyParsed.data.approvedDomains.map((domain) => domain.trim().toLowerCase())));

    const existing = await prisma.userLimit.findUnique({ where: { userId: user.id } });
    const txOps = [];

    if (bodyParsed.data.maxDomains !== undefined || bodyParsed.data.maxVms !== undefined) {
      txOps.push(
        prisma.userLimit.upsert({
          where: { userId: user.id },
          update: {
            maxDomains: bodyParsed.data.maxDomains ?? existing?.maxDomains ?? 0,
            maxVms: bodyParsed.data.maxVms ?? existing?.maxVms ?? 0
          },
          create: {
            userId: user.id,
            maxDomains: bodyParsed.data.maxDomains ?? 0,
            maxVms: bodyParsed.data.maxVms ?? 0
          }
        })
      );
    }

    if (domains !== undefined) {
      txOps.push(prisma.approvedDomain.deleteMany({ where: { userId: user.id } }));
      if (domains.length > 0) {
        txOps.push(
          prisma.approvedDomain.createMany({
            data: domains.map((domain) => ({
              userId: user.id,
              domain,
              isWildcard: domain.startsWith("*.")
            }))
          })
        );
      }
    }

    if (txOps.length > 0) {
      await prisma.$transaction(txOps);
    }

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "user.policy.updated",
      resourceType: "user",
      resourceId: String(user.id),
      payload: {
        githubUsername,
        maxDomains: bodyParsed.data.maxDomains,
        maxVms: bodyParsed.data.maxVms,
        approvedDomainsCount: domains?.length
      }
    });

    return reply.send({ success: true });
  });

  app.post("/api/admin/users/:githubUsername/suspend", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "users.write"
    });
    if (!principal) {
      return;
    }

    const paramsParsed = UserParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid params", issues: paramsParsed.error.issues });
    }

    const githubUsername = normalizeUsername(paramsParsed.data.githubUsername);
    const user = await prisma.user.findUnique({ where: { githubUsername } });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { status: "suspended" }
    });

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "user.suspended",
      resourceType: "user",
      resourceId: String(user.id),
      payload: { githubUsername }
    });

    return reply.send({ githubUsername, status: "suspended" });
  });

  // Comprehensive user update endpoint (status + limits combined)
  app.put("/api/admin/users/:githubUsername", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "users.write"
    });
    if (!principal) {
      return;
    }

    const UpdateUserSchema = z.object({
      status: z.enum(["pending", "approved", "suspended"]).optional(),
      maxDomains: z.number().int().nonnegative().optional(),
      maxVms: z.number().int().nonnegative().optional(),
      approvedDomains: z.array(z.string().min(1).max(255)).optional()
    });

    const paramsParsed = UserParamsSchema.safeParse(request.params);
    const bodyParsed = UpdateUserSchema.safeParse(request.body ?? {});
    if (!paramsParsed.success || !bodyParsed.success) {
      return reply.code(400).send({
        error: "Invalid request",
        paramsIssues: paramsParsed.success ? [] : paramsParsed.error.issues,
        bodyIssues: bodyParsed.success ? [] : bodyParsed.error.issues
      });
    }

    const githubUsername = normalizeUsername(paramsParsed.data.githubUsername);
    const user = await prisma.user.findUnique({
      where: { githubUsername },
      include: { limits: true }
    });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    const txOps = [];

    // Update user status if provided
    if (bodyParsed.data.status !== undefined) {
      txOps.push(
        prisma.user.update({
          where: { id: user.id },
          data: { status: bodyParsed.data.status }
        })
      );
    }

    // Update limits if any provided
    if (bodyParsed.data.maxDomains !== undefined || bodyParsed.data.maxVms !== undefined) {
      txOps.push(
        prisma.userLimit.upsert({
          where: { userId: user.id },
          update: {
            maxDomains: bodyParsed.data.maxDomains ?? user.limits?.maxDomains ?? 0,
            maxVms: bodyParsed.data.maxVms ?? user.limits?.maxVms ?? 0
          },
          create: {
            userId: user.id,
            maxDomains: bodyParsed.data.maxDomains ?? 0,
            maxVms: bodyParsed.data.maxVms ?? 0
          }
        })
      );
    }

    // Update approved domains if provided
    if (bodyParsed.data.approvedDomains !== undefined) {
      const domains = Array.from(
        new Set(bodyParsed.data.approvedDomains.map((domain) => domain.trim().toLowerCase()))
      );
      txOps.push(prisma.approvedDomain.deleteMany({ where: { userId: user.id } }));
      if (domains.length > 0) {
        txOps.push(
          prisma.approvedDomain.createMany({
            data: domains.map((domain) => ({
              userId: user.id,
              domain,
              isWildcard: domain.startsWith("*.")
            }))
          })
        );
      }
    }

    if (txOps.length > 0) {
      await prisma.$transaction(txOps);
    }

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "user.updated",
      resourceType: "user",
      resourceId: String(user.id),
      payload: {
        githubUsername,
        status: bodyParsed.data.status,
        maxDomains: bodyParsed.data.maxDomains,
        maxVms: bodyParsed.data.maxVms,
        approvedDomainsCount: bodyParsed.data.approvedDomains?.length
      }
    });

    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
      include: {
        limits: true,
        approvedDomains: { orderBy: { domain: "asc" } }
      }
    });

    return reply.send({
      user: {
        id: updatedUser!.id,
        githubUsername: updatedUser!.githubUsername,
        status: updatedUser!.status,
        limits: updatedUser!.limits,
        approvedDomains: updatedUser!.approvedDomains.map((item: { domain: string }) => item.domain)
      }
    });
  });

  app.post("/api/admin/users/:githubUsername/reactivate", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "users.write"
    });
    if (!principal) {
      return;
    }

    const paramsParsed = UserParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid params", issues: paramsParsed.error.issues });
    }

    const githubUsername = normalizeUsername(paramsParsed.data.githubUsername);
    const user = await prisma.user.findUnique({ where: { githubUsername } });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { status: "approved" }
    });

    await recordAuditEvent({
      actorType: "admin",
      actorId: principal.actorId,
      action: "user.reactivated",
      resourceType: "user",
      resourceId: String(user.id),
      payload: { githubUsername }
    });

    return reply.send({ githubUsername, status: "approved" });
  });
}
