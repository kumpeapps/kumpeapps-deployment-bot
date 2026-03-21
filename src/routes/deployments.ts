import type { FastifyInstance } from "fastify";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { appConfig } from "../config.js";
import {
  DeploymentConfigSchema,
  type DeploymentConfig
} from "../schemas/deployment-config.js";
import { authorizeAdminRequest } from "../services/admin-auth.js";
import { enqueueDeploymentJob } from "../services/deployment-queue.js";

const ExecuteDeploymentBodySchema = z.object({
  repositoryOwner: z.string().min(1).max(255),
  repositoryName: z.string().min(1).max(255),
  environment: z.enum(["dev", "stage", "prod"]),
  commitSha: z.string().min(7).max(80),
  triggeredBy: z.string().min(1).max(255).optional(),
  caddyHost: z.string().min(1).max(255),
  configPath: z.string().min(1).max(500),
  config: z.union([z.string().min(1), z.record(z.unknown())]),
  dryRun: z.boolean().default(true),
  timeoutMs: z.coerce.number().int().positive().max(2 * 60 * 60 * 1000).optional()
});

function parseConfig(rawConfig: string | Record<string, unknown>): DeploymentConfig {
  const payload =
    typeof rawConfig === "string" ? (parseYaml(rawConfig) as Record<string, unknown>) : rawConfig;
  const parsed = DeploymentConfigSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Invalid deployment config: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`);
  }
  return parsed.data;
}

export async function registerDeploymentRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  app.post("/api/deployments/execute", async (request, reply) => {
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

    const bodyParsed = ExecuteDeploymentBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request", issues: bodyParsed.error.issues });
    }

    let config: DeploymentConfig;
    try {
      config = parseConfig(bodyParsed.data.config);
    } catch (error) {
      return reply.code(400).send({
        error: "Invalid deployment config",
        message: error instanceof Error ? error.message : "Unable to parse deployment config"
      });
    }

    try {
      const payload = {
        repositoryOwner: bodyParsed.data.repositoryOwner,
        repositoryName: bodyParsed.data.repositoryName,
        environment: bodyParsed.data.environment,
        commitSha: bodyParsed.data.commitSha,
        triggeredBy: bodyParsed.data.triggeredBy,
        caddyHost: bodyParsed.data.caddyHost,
        configPath: bodyParsed.data.configPath,
        config,
        dryRun: bodyParsed.data.dryRun
      };

      const result = await enqueueDeploymentJob({
        label: `${payload.repositoryOwner}/${payload.repositoryName}:${payload.environment}:${payload.configPath}`,
        payload,
        timeoutMs: bodyParsed.data.timeoutMs ?? appConfig.DEPLOY_QUEUE_JOB_TIMEOUT_MS
      });

      return reply.code(202).send({
        accepted: true,
        jobId: result.jobId,
        dryRun: bodyParsed.data.dryRun,
        timeoutMs: bodyParsed.data.timeoutMs ?? appConfig.DEPLOY_QUEUE_JOB_TIMEOUT_MS
      });
    } catch (error) {
      app.log.error({ error }, "Deployment execution failed");
      return reply.code(400).send({
        accepted: false,
        error: error instanceof Error ? error.message : "Deployment failed"
      });
    }
  });
}
