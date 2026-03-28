import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { authorizeAdminRequest } from "../services/admin-auth.js";
import { getGithubAdminSessionUsername } from "../services/admin-github-session.js";
import { enqueueDeploymentJob } from "../services/deployment-queue.js";
import { initializeRepository } from "../services/repository-initialization.js";
import { cleanupRepository } from "../services/repository-cleanup.js";
import { recordAuditEvent } from "../services/audit.js";

export async function registerRepositoryManagementRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  /**
   * GET /api/admin/repositories
   * List all repositories the user has access to
   * Admins see all, regular users see only their repositories
   */
  app.get("/api/admin/repositories", async (request, reply) => {
    const principal = authorizeAdminRequest({
      request,
      reply,
      fallbackToken: options.adminToken,
      requiredPermission: "users.read" // Using existing permission for now
    });

    if (!principal) {
      return;
    }

    const QuerySchema = z.object({
      owner: z.string().optional(),
      active: z
        .string()
        .optional()
        .transform((val) => (val === "true" ? true : val === "false" ? false : undefined)),
      limit: z.coerce.number().int().positive().max(500).default(100),
      offset: z.coerce.number().int().nonnegative().default(0)
    });

    const queryParsed = QuerySchema.safeParse(request.query ?? {});
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: queryParsed.error.issues });
    }

    // Determine if user is admin (owner role sees everything)
    const isAdmin = principal.role === "owner";
    
    // Extract username from principal for non-admin users
    let filterUsername: string | null = null;
    if (!isAdmin) {
      // principal.actorId format: "admin:github:{username}" or "admin:token:{hash}"
      const match = principal.actorId.match(/^admin:github:(.+)$/);
      if (match) {
        filterUsername = match[1];
      } else {
        // Token-based users without a specific username can't see any repos (unless owner)
        return reply.send({
          repositories: [],
          pagination: {
            limit: queryParsed.data.limit,
            offset: queryParsed.data.offset,
            total: 0
          }
        });
      }
    }

    // Build where clause
    const whereClause: any = {};
    if (queryParsed.data.owner) {
      whereClause.owner = queryParsed.data.owner;
    }
    if (queryParsed.data.active !== undefined) {
      whereClause.active = queryParsed.data.active;
    }

    const [repositories, totalCount] = await Promise.all([
      prisma.repository.findMany({
        where: whereClause,
        take: queryParsed.data.limit,
        skip: queryParsed.data.offset,
        orderBy: [{ owner: 'asc' }, { name: 'asc' }],
        include: {
          configSnapshots: !isAdmin && filterUsername ? {
            select: {
              id: true,
              parsedJson: true
            }
          } : false
        }
      }),
      prisma.repository.count({ where: whereClause })
    ]);

    // Filter repositories for non-admin users based on assigned_username in configs
    let filteredRepositories = repositories;
    if (!isAdmin && filterUsername) {
      filteredRepositories = repositories.filter((repo: any) => {
        const configs = repo.configSnapshots || [];
        return configs.some((config: any) => {
          const parsedJson = config.parsedJson as any;
          const assignedUsername = parsedJson?.assigned_username;
          return assignedUsername && assignedUsername.toLowerCase() === filterUsername.toLowerCase();
        });
      });
    }

    // Check if each repository is initialized (has apiToken)
    const repositoriesWithStatus = await Promise.all(filteredRepositories.map(async (repo: any) => {
      const isInitialized = !!(repo as any).apiToken;
      
      // Count configs and secrets separately
      const [configCount, secretCount] = await Promise.all([
        prisma.deploymentConfig.count({ where: { repositoryId: repo.id } }),
        prisma.repositorySecret.count({ where: { repositoryId: repo.id } })
      ]);
      
      return {
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        active: repo.active,
        installationId: repo.installationId ? String(repo.installationId) : null,
        isInitialized,
        configCount,
        secretCount,
        createdAt: repo.createdAt
      };
    }));

    return reply.send({
      repositories: repositoriesWithStatus,
      pagination: {
        limit: queryParsed.data.limit,
        offset: queryParsed.data.offset,
        total: !isAdmin && filterUsername ? repositoriesWithStatus.length : totalCount
      }
    });
  });

  /**
   * POST /api/admin/repositories/:owner/:name/redeploy
   * Manually trigger a deployment
   * TODO: Full implementation requires fetching config from repository
   */
  app.post("/api/admin/repositories/:owner/:name/redeploy", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "deployments.execute"
      })
    ) {
      return;
    }

    // TODO: Implement - needs to fetch config, parse it, and construct full payload
    return reply.code(501).send({
      error: "Not yet implemented",
      message: "Use GitHub push/PR to trigger deployments for now"
    });
  });

  /**
   * DELETE /api/admin/repositories/:owner/:name/secrets
   * Clear all secrets for a repository
   */
  app.delete("/api/admin/repositories/:owner/:name/secrets", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "repositorySecrets.write"
      })
    ) {
      return;
    }

    const ParamsSchema = z.object({
      owner: z.string().min(1),
      name: z.string().min(1)
    });

    const paramsResult = ParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send({ error: "Invalid parameters", issues: paramsResult.error.issues });
    }

    const { owner, name } = paramsResult.data;

    const repository = await prisma.repository.findUnique({
      where: { owner_name: { owner, name } }
    });

    if (!repository) {
      return reply.code(404).send({ error: "Repository not found" });
    }

    const deleted = await prisma.repositorySecret.deleteMany({
      where: { repositoryId: repository.id }
    });

    await recordAuditEvent({
      actorType: "user",
      actorId: getGithubAdminSessionUsername(request) ?? "admin",
      action: "repositorySecrets.bulk_delete",
      resourceType: "repositorySecret",
      resourceId: `${owner}/${name}`,
      payload: {
        deletedCount: deleted.count
      }
    });

    return reply.send({
      success: true,
      deletedCount: deleted.count,
      message: `Cleared ${deleted.count} secrets for ${owner}/${name}`
    });
  });

  /**
   * POST /api/admin/repositories/:owner/:name/initialize
   * Manually initialize a repository
   */
  app.post("/api/admin/repositories/:owner/:name/initialize", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "users.write"
      })
    ) {
      return;
    }

    const ParamsSchema = z.object({
      owner: z.string().min(1),
      name: z.string().min(1)
    });

    const paramsResult = ParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send({ error: "Invalid parameters", issues: paramsResult.error.issues });
    }

    const { owner, name } = paramsResult.data;

    try {
      const result = await initializeRepository({
        repositoryOwner: owner,
        repositoryName: name,
        // No existing issue - will create a new initialization issue
        existingIssue: undefined
      });

      if (result.error) {
        return reply.code(400).send({
          success: false,
          error: result.error
        });
      }

      await recordAuditEvent({
        actorType: "user",
        actorId: getGithubAdminSessionUsername(request) ?? "admin",
        action: "repository.manual_initialization",
        resourceType: "repository",
        resourceId: `${owner}/${name}`,
        payload: {
          issueNumber: result.issueNumber
        }
      });

      return reply.send({
        success: true,
        issueNumber: result.issueNumber
      });
    } catch (error) {
      app.log.error({ error, owner, name }, "Failed to initialize repository");
      return reply.code(500).send({
        error: "Initialization failed",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  /**
   * POST /api/admin/repositories/:owner/:name/cleanup
   * Cleanup repository resources (configs, secrets, Nebula clients)
   * Does NOT delete the repository record itself
   */
  app.post("/api/admin/repositories/:owner/:name/cleanup", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "users.write"
      })
    ) {
      return;
    }

    const ParamsSchema = z.object({
      owner: z.string().min(1),
      name: z.string().min(1)
    });

    const BodySchema = z.object({
      reason: z.string().optional()
    });

    const paramsResult = ParamsSchema.safeParse(request.params);
    const bodyResult = BodySchema.safeParse(request.body);

    if (!paramsResult.success || !bodyResult.success) {
      return reply.code(400).send({
        error: "Invalid request",
        paramsIssues: paramsResult.success ? undefined : paramsResult.error.issues,
        bodyIssues: bodyResult.success ? undefined : bodyResult.error.issues
      });
    }

    const { owner, name } = paramsResult.data;
    const { reason } = bodyResult.data;

    const result = await cleanupRepository({
      owner,
      name,
      reason: reason ?? `Manual cleanup by ${getGithubAdminSessionUsername(request) ?? "admin"}`,
      logger: app.log
    });

    if (!result.repository) {
      return reply.code(404).send({ error: "Repository not found" });
    }

    return reply.send({
      success: true,
      deletedConfigs: result.deletedConfigs,
      deletedSecrets: result.deletedSecrets,
      nebulaResults: result.nebulaResults,
      message: `Cleaned up resources for ${owner}/${name}`
    });
  });

  /**
   * DELETE /api/admin/repositories/:owner/:name
   * Remove repository and cleanup all resources
   * This completely removes the repository record from the database
   */
  app.delete("/api/admin/repositories/:owner/:name", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "users.write"
      })
    ) {
      return;
    }

    const ParamsSchema = z.object({
      owner: z.string().min(1),
      name: z.string().min(1)
    });

    const paramsResult = ParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send({ error: "Invalid parameters", issues: paramsResult.error.issues });
    }

    const { owner, name } = paramsResult.data;

    // First cleanup resources
    const cleanupResult = await cleanupRepository({
      owner,
      name,
      reason: `Repository removal by ${getGithubAdminSessionUsername(request) ?? "admin"}`,
      logger: app.log
    });

    if (!cleanupResult.repository) {
      return reply.code(404).send({ error: "Repository not found" });
    }

    // Then delete the repository record
    await prisma.repository.delete({
      where: { id: cleanupResult.repository.id }
    });

    await recordAuditEvent({
      actorType: "user",
      actorId: getGithubAdminSessionUsername(request) ?? "admin",
      action: "repository.manual_deletion",
      resourceType: "repository",
      resourceId: `${owner}/${name}`,
      payload: {
        deletedConfigs: cleanupResult.deletedConfigs,
        deletedSecrets: cleanupResult.deletedSecrets,
        nebulaResults: cleanupResult.nebulaResults
      }
    });

    return reply.send({
      success: true,
      message: `Repository ${owner}/${name} and all resources removed`,
      deletedConfigs: cleanupResult.deletedConfigs,
      deletedSecrets: cleanupResult.deletedSecrets,
      nebulaResults: cleanupResult.nebulaResults
    });
  });
}
