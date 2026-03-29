import Fastify from "fastify";
import { mkdir, writeFile, chmod, access, constants } from "fs/promises";
import { dirname } from "path";
import { appConfig } from "./config.js";
import { prisma } from "./db.js";
import { registerAuditEventRoutes } from "./routes/audit-events.js";
import { registerConfigValidationRoutes } from "./routes/config-validation.js";
import { registerDeploymentQueryRoutes } from "./routes/deployment-queries.js";
import { registerDeploymentRoutes } from "./routes/deployments.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerOperationsRoutes } from "./routes/operations.js";
import { registerRepositoryConfigRoutes } from "./routes/repository-configs.js";
import { registerRepositorySecretRoutes } from "./routes/repository-secrets.js";
import { registerRepositoryManagementRoutes } from "./routes/repository-management.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerRbacRoutes } from "./routes/rbac.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerAdminDashboardRoutes } from "./routes/admin-dashboard.js";
import { registerWebhookDeliveryRoutes } from "./routes/webhook-deliveries.js";
import { startDeploymentQueueWorker, stopDeploymentQueueWorker } from "./services/deployment-queue.js";
import { startTokenProvisioningScheduler } from "./services/repository-token-provisioning.js";
import { pruneExpiredSnoozesRecords } from "./services/alert-snooze-cleanup.js";
import { pruneOldDeploymentJobs } from "./services/deployment-job-cleanup.js";
import { pruneOldWebhookDeliveries } from "./services/webhook-delivery-cleanup.js";
import { startWebhookRetryScheduler, stopWebhookRetryScheduler } from "./services/webhook-retry-scheduler.js";
import { InMemoryRateLimiter } from "./services/rate-limit.js";
import { recordAdminApiAuthFailure } from "./services/admin-api-security-health.js";
import { recordRateLimitBlockedRequest } from "./services/rate-limit-health.js";
import {
  bootstrapAdminRoleBindingsFromEnv,
  isAdminRequestAuthorized,
  refreshAdminRoleBindingsCache
} from "./services/admin-auth.js";

const app = Fastify({
  disableRequestLogging: true,
  trustProxy: true, // Trust X-Forwarded-* headers from reverse proxy
  logger: {
    level: appConfig.LOG_LEVEL,
    transport: appConfig.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined
  }
});

if (appConfig.HTTP_ACCESS_LOG_ENABLED) {
  app.addHook("onRequest", async (request) => {
    request.log.debug(
      {
        requestId: request.id,
        method: request.method,
        path: request.url,
        ip: request.ip
      },
      "HTTP request start"
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode,
        responseTimeMs: Number(reply.elapsedTime.toFixed(2)),
        ip: request.ip
      },
      "HTTP request complete"
    );
  });

  app.addHook("onError", async (request, reply, error) => {
    request.log.error(
      {
        requestId: request.id,
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode,
        errorMessage: error.message,
        ip: request.ip
      },
      "HTTP request failed"
    );
  });
}

if (appConfig.RATE_LIMIT_ENABLED) {
  const limiter = new InMemoryRateLimiter(appConfig.RATE_LIMIT_WINDOW_MS);

  app.addHook("onRequest", async (request, reply) => {
    const isWebhook = request.url.startsWith("/github/webhook");
    const maxRequests = isWebhook
      ? appConfig.RATE_LIMIT_WEBHOOK_MAX_REQUESTS
      : appConfig.RATE_LIMIT_MAX_REQUESTS;

    const key = `${request.ip}:${isWebhook ? "webhook" : "default"}`;
    const result = limiter.consume(key, maxRequests);

    reply.header("X-RateLimit-Limit", String(maxRequests));
    reply.header("X-RateLimit-Remaining", String(result.remaining));
    reply.header("X-RateLimit-Reset", String(result.resetEpochSeconds));

    if (!result.allowed) {
      recordRateLimitBlockedRequest({ isWebhook });
      return reply.code(429).send({
        error: "Too Many Requests",
        message: "Rate limit exceeded"
      });
    }
  });
}

app.addHook("onRequest", async (request) => {
  if (!request.url.startsWith("/api/admin")) {
    return;
  }

  if (!isAdminRequestAuthorized(request, appConfig.ADMIN_API_TOKEN)) {
    const tokenHeader = request.headers["x-admin-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    recordAdminApiAuthFailure({ tokenPresent: typeof token === "string" && token.length > 0 });
  }
});

app.register(registerHealthRoutes);
app.register(registerWebhookRoutes, { webhookSecret: appConfig.GITHUB_APP_WEBHOOK_SECRET });
app.register(registerUserRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerRepositorySecretRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerRepositoryManagementRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerPlanRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerRepositoryConfigRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerOperationsRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerAuditEventRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerWebhookDeliveryRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerConfigValidationRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerDeploymentRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerDeploymentQueryRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerRbacRoutes, { adminToken: appConfig.ADMIN_API_TOKEN });
app.register(registerAdminDashboardRoutes);

app.get("/", async (_request, reply) => {
  return reply.redirect("/admin");
});

/**
 * Ensure SSH known_hosts file and directory exist with proper permissions
 * This prevents SSH errors when StrictHostKeyChecking=accept-new tries to write to the file
 */
async function ensureSshKnownHostsFileExists(): Promise<void> {
  try {
    const knownHostsPath = appConfig.SSH_KNOWN_HOSTS_PATH;
    
    // Validate path - must not be a directory or end with /
    if (knownHostsPath.endsWith('/')) {
      throw new Error(`SSH_KNOWN_HOSTS_PATH must be a file path, not a directory. Got: ${knownHostsPath} - Please set it to a full file path like /root/.ssh/known_hosts or /dev/null`);
    }
    
    // Special case: /dev/null doesn't need setup
    if (knownHostsPath === "/dev/null") {
      console.log(`[SSH Setup] Using /dev/null for known_hosts (host key verification disabled)`);
      return;
    }
    
    const knownHostsDir = dirname(knownHostsPath);
    
    console.log(`[SSH Setup] Ensuring known_hosts file exists: ${knownHostsPath}`);
    
    // Create directory if it doesn't exist
    await mkdir(knownHostsDir, { recursive: true, mode: 0o755 });
    console.log(`[SSH Setup] Directory ensured: ${knownHostsDir}`);
    
    // Create empty known_hosts file if it doesn't exist
    try {
      await writeFile(knownHostsPath, "", { flag: "wx", mode: 0o644 });
      console.log(`[SSH Setup] Created known_hosts file: ${knownHostsPath}`);
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        console.log(`[SSH Setup] Known_hosts file already exists: ${knownHostsPath}`);
      } else {
        throw error;
      }
    }
    
    // Ensure file has proper permissions (make it writable)
    try {
      await chmod(knownHostsPath, 0o644);
      console.log(`[SSH Setup] Set permissions 0o644 on ${knownHostsPath}`);
    } catch (error) {
      console.warn(`[SSH Setup] Could not set permissions on known_hosts:`, error);
    }
    
    // Verify the file is actually writable
    try {
      await access(knownHostsPath, constants.W_OK);
      console.log(`[SSH Setup] Verified known_hosts file is writable`);
    } catch (error) {
      console.error(`[SSH Setup] Known_hosts file is NOT writable:`, error);
      console.error(`[SSH Setup] This will cause SSH connection failures with StrictHostKeyChecking=accept-new.`);
      console.error(`[SSH Setup] Solutions:`);
      console.error(`[SSH Setup]   1. Set SSH_STRICT_HOST_KEY_CHECKING=no (disables host key verification)`);
      console.error(`[SSH Setup]   2. Set SSH_KNOWN_HOSTS_PATH=/dev/null (writes go nowhere)`);
      console.error(`[SSH Setup]   3. Fix file permissions: chmod 666 ${knownHostsPath}`);
    }
    
  } catch (error) {
    console.error(`[SSH Setup] Failed to ensure known_hosts file exists:`, error);
    console.error(`[SSH Setup] SSH connections may fail. Recommended: Set SSH_KNOWN_HOSTS_PATH=/dev/null`);
    // Don't fail startup - but log the error prominently
  }
}

async function start(): Promise<void> {
  try {
    // Ensure SSH known_hosts file exists before any SSH operations
    await ensureSshKnownHostsFileExists();
    
    await refreshAdminRoleBindingsCache();
    await bootstrapAdminRoleBindingsFromEnv(appConfig.ADMIN_API_TOKEN);
    await startDeploymentQueueWorker(app.log);
    
    // Run cleanup of expired snoozes and old jobs on startup
    try {
      await pruneExpiredSnoozesRecords();
    } catch (error) {
      app.log.warn({ error }, "Failed to prune expired snoozes on startup");
    }
    
    try {
      await pruneOldDeploymentJobs();
    } catch (error) {
      app.log.warn({ error }, "Failed to prune old deployment jobs on startup");
    }

    try {
      await pruneOldWebhookDeliveries();
    } catch (error) {
      app.log.warn({ error }, "Failed to prune old webhook deliveries on startup");
    }

    // Start repository token provisioning scheduler
    if (appConfig.REPOSITORY_TOKEN_PROVISIONING_ENABLED) {
      app.log.info(
        { intervalMs: appConfig.REPOSITORY_TOKEN_PROVISIONING_INTERVAL_MS },
        "Starting repository token provisioning scheduler"
      );
      startTokenProvisioningScheduler(
        appConfig.REPOSITORY_TOKEN_PROVISIONING_INTERVAL_MS,
        app.log
      );
    }

    // Start webhook retry scheduler
    if (appConfig.WEBHOOK_RETRY_ENABLED) {
      app.log.info(
        { 
          intervalMs: appConfig.WEBHOOK_RETRY_INTERVAL_MS,
          maxAttempts: appConfig.WEBHOOK_RETRY_MAX_ATTEMPTS
        },
        "Starting webhook retry scheduler"
      );
      startWebhookRetryScheduler(
        appConfig.WEBHOOK_RETRY_INTERVAL_MS,
        app.log
      );
    }
    
    await app.listen({ host: "0.0.0.0", port: appConfig.PORT });
    app.log.info({ port: appConfig.PORT }, "Bot service listening");
  } catch (error) {
    app.log.error({ error }, "Failed to start service");
    process.exit(1);
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "Shutting down");
  stopDeploymentQueueWorker();
  stopWebhookRetryScheduler(app.log);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  app.log.error({ reason }, "Unhandled promise rejection");
  void shutdown("SIGTERM");
});

process.on("uncaughtException", (error) => {
  app.log.fatal({ error }, "Uncaught exception");
  void shutdown("SIGTERM");
});

void start();
