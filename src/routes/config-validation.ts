import type { FastifyInstance } from "fastify";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { authorizeAdminRequest } from "../services/admin-auth.js";
import {
  DeploymentConfigSchema,
  type DeploymentConfig,
  validateDeploymentPolicy
} from "../schemas/deployment-config.js";

const ValidateBodySchema = z.object({
  config: z.union([z.string().min(1), z.record(z.unknown())]),
  expectedUsername: z.string().min(1).max(255).optional(),
  approvedDomains: z.array(z.string().min(1).max(255)).default([]),
  authorizedPlans: z.array(z.string().min(1).max(255)).default([]),
  maxDomains: z.number().int().nonnegative(),
  maxVms: z.number().int().nonnegative(),
  currentVmCount: z.number().int().nonnegative().default(0)
});

function parseConfigObject(rawConfig: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof rawConfig === "string") {
    const parsed = parseYaml(rawConfig);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Config YAML must parse to an object");
    }
    return parsed as Record<string, unknown>;
  }

  return rawConfig;
}

export async function registerConfigValidationRoutes(
  app: FastifyInstance,
  options: { adminToken: string }
): Promise<void> {
  app.post("/api/config/validate", async (request, reply) => {
    if (
      !authorizeAdminRequest({
        request,
        reply,
        fallbackToken: options.adminToken,
        requiredPermission: "config.validate"
      })
    ) {
      return;
    }

    const bodyParsed = ValidateBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request", issues: bodyParsed.error.issues });
    }

    let configData: Record<string, unknown>;
    try {
      configData = parseConfigObject(bodyParsed.data.config);
    } catch (error) {
      return reply.code(400).send({
        error: "Invalid config parse",
        message: error instanceof Error ? error.message : "Unable to parse config"
      });
    }

    const configParsed = DeploymentConfigSchema.safeParse(configData);
    if (!configParsed.success) {
      return reply.code(400).send({ error: "Invalid config schema", issues: configParsed.error.issues });
    }

    const config: DeploymentConfig = configParsed.data;
    const policyErrors = validateDeploymentPolicy({
      config,
      expectedUsername: bodyParsed.data.expectedUsername,
      approvedDomains: bodyParsed.data.approvedDomains,
      authorizedPlans: bodyParsed.data.authorizedPlans,
      maxDomains: bodyParsed.data.maxDomains,
      maxVms: bodyParsed.data.maxVms,
      currentVmCount: bodyParsed.data.currentVmCount
    });

    return reply.send({
      valid: policyErrors.length === 0,
      errors: policyErrors,
      normalized: config
    });
  });
}
