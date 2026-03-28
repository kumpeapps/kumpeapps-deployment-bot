import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { authorizeAdminRequest } from "../services/admin-auth.js";
import { validateRepositoryToken } from "../services/repository-tokens.js";
import { recordAuditEvent } from "../services/audit.js";
import { encryptSecretValue } from "../services/secret-crypto.js";

const UpsertRepositorySecretBodySchema = z.object({
  repositoryOwner: z.string().min(1).max(255),
  repositoryName: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  value: z.string().min(1)
});

export async function registerRepositorySecretRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  // List repository secrets (names only, not values)
  app.get("/api/admin/repository-secrets", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "repositorySecrets.read"
      })
    ) {
      return;
    }

    const QuerySchema = z.object({
      repositoryOwner: z.string().min(1).max(255).optional(),
      repositoryName: z.string().min(1).max(255).optional(),
      limit: z.coerce.number().int().positive().max(500).default(100)
    });

    const queryParsed = QuerySchema.safeParse(request.query ?? {});
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    let whereClause = {};
    if (queryParsed.data.repositoryOwner && queryParsed.data.repositoryName) {
      const repository = await prisma.repository.findUnique({
        where: {
          owner_name: {
            owner: queryParsed.data.repositoryOwner,
            name: queryParsed.data.repositoryName
          }
        }
      });

      if (!repository) {
        return reply.send({ count: 0, secrets: [] });
      }

      whereClause = { repositoryId: repository.id };
    }

    const secrets = await prisma.repositorySecret.findMany({
      where: whereClause,
      include: {
        repository: {
          select: {
            id: true,
            owner: true,
            name: true
          }
        }
      },
      orderBy: { name: "asc" },
      take: queryParsed.data.limit
    });

    return reply.send({
      count: secrets.length,
      secrets: secrets.map((secret) => ({
        id: secret.id,
        repositoryOwner: secret.repository.owner,
        repositoryName: secret.repository.name,
        name: secret.name,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt
      }))
    });
  });

  app.post("/api/admin/repository-secrets/upsert", async (request, reply) => {
    const bodyParsed = UpsertRepositorySecretBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request", issues: bodyParsed.error.issues });
    }

    // Extract token from Authorization header
    const authHeader = request.headers.authorization as string | undefined;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

    let actorId = "unknown";
    let actorType: "admin" | "repository" = "admin";

    // Try repository token first (if token starts with kdbt_)
    if (token.startsWith("kdbt_")) {
      const isValid = await validateRepositoryToken({
        repositoryOwner: bodyParsed.data.repositoryOwner,
        repositoryName: bodyParsed.data.repositoryName,
        token
      });

      if (!isValid) {
        return reply.code(401).send({ error: "Invalid repository token" });
      }

      actorId = `${bodyParsed.data.repositoryOwner}/${bodyParsed.data.repositoryName}`;
      actorType = "repository";
    } else {
      // Fall back to admin authorization
      const principal = authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "repositorySecrets.write"
      });

      if (!principal) {
        return;
      }

      actorId = principal.actorId;
    }

    const repository = await prisma.repository.findUnique({
      where: {
        owner_name: {
          owner: bodyParsed.data.repositoryOwner,
          name: bodyParsed.data.repositoryName
        }
      }
    });

    if (!repository) {
      return reply.code(404).send({ error: "Repository not found in control plane" });
    }

    const secret = await prisma.repositorySecret.upsert({
      where: {
        repositoryId_name: {
          repositoryId: repository.id,
          name: bodyParsed.data.name
        }
      },
      update: {
        value: encryptSecretValue(bodyParsed.data.value)
      },
      create: {
        repositoryId: repository.id,
        name: bodyParsed.data.name,
        value: encryptSecretValue(bodyParsed.data.value)
      }
    });

    await recordAuditEvent({
      actorType,
      actorId,
      action: "repository.secret.upserted",
      resourceType: "repository_secret",
      resourceId: String(secret.id),
      payload: {
        repositoryOwner: bodyParsed.data.repositoryOwner,
        repositoryName: bodyParsed.data.repositoryName,
        secretName: secret.name
      }
    });

    return reply.send({
      repositoryOwner: bodyParsed.data.repositoryOwner,
      repositoryName: bodyParsed.data.repositoryName,
      name: secret.name,
      updatedAt: secret.updatedAt
    });
  });

  // Bulk sync secrets - replaces all secrets for a repository
  app.post("/api/admin/repository-secrets/sync", async (request, reply) => {
    const SyncBodySchema = z.object({
      repositoryOwner: z.string().min(1).max(255),
      repositoryName: z.string().min(1).max(255),
      secrets: z.array(
        z.object({
          name: z.string().min(1).max(255),
          value: z.string().min(1)
        })
      )
    });

    const bodyParsed = SyncBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request", issues: bodyParsed.error.issues });
    }

    // Extract token from Authorization header
    const authHeader = request.headers.authorization as string | undefined;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

    let actorId = "unknown";
    let actorType: "admin" | "repository" = "admin";

    // Try repository token first (if token starts with kdbt_)
    if (token.startsWith("kdbt_")) {
      const isValid = await validateRepositoryToken({
        repositoryOwner: bodyParsed.data.repositoryOwner,
        repositoryName: bodyParsed.data.repositoryName,
        token
      });

      if (!isValid) {
        return reply.code(401).send({ error: "Invalid repository token" });
      }

      actorId = `${bodyParsed.data.repositoryOwner}/${bodyParsed.data.repositoryName}`;
      actorType = "repository";
    } else {
      // Fall back to admin authorization
      const principal = authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "repositorySecrets.write"
      });

      if (!principal) {
        return;
      }

      actorId = principal.actorId;
    }

    const repository = await prisma.repository.findUnique({
      where: {
        owner_name: {
          owner: bodyParsed.data.repositoryOwner,
          name: bodyParsed.data.repositoryName
        }
      }
    });

    if (!repository) {
      return reply.code(404).send({ error: "Repository not found in control plane" });
    }

    // Get current secrets to determine what to delete
    const existingSecrets = await prisma.repositorySecret.findMany({
      where: { repositoryId: repository.id },
      select: { name: true, id: true }
    });

    const newSecretNames = new Set(bodyParsed.data.secrets.map(s => s.name));
    const secretsToDelete = existingSecrets.filter(s => !newSecretNames.has(s.name));

    // Perform sync in a transaction
    await prisma.$transaction(async (tx) => {
      // Delete secrets not in the new set
      if (secretsToDelete.length > 0) {
        await tx.repositorySecret.deleteMany({
          where: {
            repositoryId: repository.id,
            name: { in: secretsToDelete.map(s => s.name) }
          }
        });
      }

      // Upsert all new secrets
      for (const secret of bodyParsed.data.secrets) {
        await tx.repositorySecret.upsert({
          where: {
            repositoryId_name: {
              repositoryId: repository.id,
              name: secret.name
            }
          },
          update: {
            value: encryptSecretValue(secret.value)
          },
          create: {
            repositoryId: repository.id,
            name: secret.name,
            value: encryptSecretValue(secret.value)
          }
        });
      }
    });

    await recordAuditEvent({
      actorType,
      actorId,
      action: "repository.secrets.synced",
      resourceType: "repository",
      resourceId: `${bodyParsed.data.repositoryOwner}/${bodyParsed.data.repositoryName}`,
      payload: {
        repositoryOwner: bodyParsed.data.repositoryOwner,
        repositoryName: bodyParsed.data.repositoryName,
        secretCount: bodyParsed.data.secrets.length,
        secretsDeleted: secretsToDelete.length,
        secretNames: bodyParsed.data.secrets.map(s => s.name)
      }
    });

    return reply.send({
      repositoryOwner: bodyParsed.data.repositoryOwner,
      repositoryName: bodyParsed.data.repositoryName,
      synced: bodyParsed.data.secrets.length,
      deleted: secretsToDelete.length,
      secretNames: bodyParsed.data.secrets.map(s => s.name)
    });
  });

  // Get unique repositories that have secrets
  app.get("/api/admin/repository-secrets/repositories", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "repositorySecrets.read"
      })
    ) {
      return;
    }

    const secrets = await prisma.repositorySecret.findMany({
      select: {
        repository: {
          select: {
            owner: true,
            name: true
          }
        }
      },
      distinct: ["repositoryId"],
      orderBy: {
        repository: {
          owner: "asc"
        }
      }
    });

    const repositories = secrets.map(s => ({
      owner: s.repository.owner,
      name: s.repository.name
    }));

    return reply.send({ repositories });
  });
}

