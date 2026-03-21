import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import {
  adminApiSecurityHealthStats,
  adminApiSecurityPrometheusMetrics
} from "../services/admin-api-security-health.js";
import {
  deploymentCompensationHealthStats,
  deploymentCompensationPrometheusMetrics
} from "../services/deployment-compensation-health.js";
import {
  deploymentQueueDetailedStats,
  deploymentQueuePrometheusMetrics,
  deploymentQueueStats
} from "../services/deployment-queue.js";
import { githubApiHealthStats, githubApiPrometheusMetrics } from "../services/github-status.js";
import { rateLimitHealthStats, rateLimitPrometheusMetrics } from "../services/rate-limit-health.js";
import { secretEncryptionHealthStats, secretEncryptionPrometheusMetrics } from "../services/secret-health.js";
import { sshHealthStats, sshPrometheusMetrics } from "../services/ssh-health.js";
import { webhookDeliveryPrometheusMetrics, webhookDeliveryStats } from "../services/webhook-delivery-metrics.js";
import { webhookSecurityHealthStats, webhookSecurityPrometheusMetrics } from "../services/webhook-security-health.js";
import { virtualizorHealthStats, virtualizorPrometheusMetrics } from "../services/virtualizor-health.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const queue = await deploymentQueueStats();
    const queueDetailed = await deploymentQueueDetailedStats();
    const webhookDeliveries = await webhookDeliveryStats();
    const secretEncryption = secretEncryptionHealthStats();
    const githubApi = githubApiHealthStats();
    const ssh = sshHealthStats();
    const webhookSecurity = webhookSecurityHealthStats();
    const virtualizor = virtualizorHealthStats();
    const adminApiSecurity = adminApiSecurityHealthStats();
    const rateLimit = rateLimitHealthStats();
    const deploymentCompensation = deploymentCompensationHealthStats();

    const alertSources = [
      queueDetailed.alerts.requiresAttentionEffective ? "deploymentQueue" : null,
      webhookDeliveries.alerts.requiresAttention ? "webhookDeliveries" : null,
      secretEncryption.alerts.requiresAttention ? "secretEncryption" : null,
      githubApi.alerts.requiresAttention ? "githubApi" : null,
      ssh.alerts.requiresAttention ? "ssh" : null,
      webhookSecurity.alerts.requiresAttention ? "webhookSecurity" : null,
      virtualizor.alerts.requiresAttention ? "virtualizor" : null,
      adminApiSecurity.alerts.requiresAttention ? "adminApiSecurity" : null
      , rateLimit.alerts.requiresAttention ? "rateLimit" : null,
      deploymentCompensation.alerts.requiresAttention ? "deploymentCompensation" : null
    ].filter((item): item is string => item !== null);

    const requiresAttention = alertSources.length > 0;

    return {
      status: "ok",
      state: requiresAttention ? "degraded" : "healthy",
      alerts: {
        requiresAttention,
        sourceCount: alertSources.length,
        sources: alertSources
      },
      deploymentQueue: queue,
      webhookDeliveries,
      secretEncryption,
      githubApi,
      ssh,
      webhookSecurity,
      virtualizor,
      adminApiSecurity,
      rateLimit,
      deploymentCompensation
    };
  });

  app.get("/health/db", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ok", db: "reachable" };
    } catch (error) {
      app.log.error({ error }, "Database health check failed");
      return reply.code(503).send({ status: "error", db: "unreachable" });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    const queueDetailed = await deploymentQueueDetailedStats();
    const webhookDeliveries = await webhookDeliveryStats();
    const secretEncryption = secretEncryptionHealthStats();
    const githubApi = githubApiHealthStats();
    const ssh = sshHealthStats();
    const webhookSecurity = webhookSecurityHealthStats();
    const virtualizor = virtualizorHealthStats();
    const adminApiSecurity = adminApiSecurityHealthStats();
    const rateLimit = rateLimitHealthStats();
    const deploymentCompensation = deploymentCompensationHealthStats();

    const alertSources = [
      queueDetailed.alerts.requiresAttentionEffective ? "deploymentQueue" : null,
      webhookDeliveries.alerts.requiresAttention ? "webhookDeliveries" : null,
      secretEncryption.alerts.requiresAttention ? "secretEncryption" : null,
      githubApi.alerts.requiresAttention ? "githubApi" : null,
      ssh.alerts.requiresAttention ? "ssh" : null,
      webhookSecurity.alerts.requiresAttention ? "webhookSecurity" : null,
      virtualizor.alerts.requiresAttention ? "virtualizor" : null,
      adminApiSecurity.alerts.requiresAttention ? "adminApiSecurity" : null
      , rateLimit.alerts.requiresAttention ? "rateLimit" : null,
      deploymentCompensation.alerts.requiresAttention ? "deploymentCompensation" : null
    ].filter((item): item is string => item !== null);

    const queueMetrics = await deploymentQueuePrometheusMetrics();
    const webhookMetrics = await webhookDeliveryPrometheusMetrics();
    const secretMetrics = secretEncryptionPrometheusMetrics();
    const githubApiMetrics = githubApiPrometheusMetrics();
    const sshMetrics = sshPrometheusMetrics();
    const webhookSecurityMetrics = webhookSecurityPrometheusMetrics();
    const virtualizorMetrics = virtualizorPrometheusMetrics();
    const adminApiSecurityMetrics = adminApiSecurityPrometheusMetrics();
    const rateLimitMetrics = rateLimitPrometheusMetrics();
    const deploymentCompensationMetrics = deploymentCompensationPrometheusMetrics();

    const aggregatedAlertMetricsLines: string[] = [
      "# HELP system_alert_requires_attention_flag Aggregated system alert flag across all subsystems",
      "# TYPE system_alert_requires_attention_flag gauge",
      `system_alert_requires_attention_flag ${alertSources.length > 0 ? 1 : 0}`,
      "",
      "# HELP system_alert_sources_total Number of subsystems currently requiring attention",
      "# TYPE system_alert_sources_total gauge",
      `system_alert_sources_total ${alertSources.length}`,
      ""
    ];

    for (const source of [
      "deploymentQueue",
      "webhookDeliveries",
      "secretEncryption",
      "githubApi",
      "ssh",
      "webhookSecurity",
      "virtualizor",
      "adminApiSecurity",
      "rateLimit",
      "deploymentCompensation"
    ]) {
      const isActive = alertSources.includes(source);
      aggregatedAlertMetricsLines.push(`# HELP system_alert_source_flag Subsystem alert membership flag by source`);
      aggregatedAlertMetricsLines.push(`# TYPE system_alert_source_flag gauge`);
      aggregatedAlertMetricsLines.push(`system_alert_source_flag{source="${source}"} ${isActive ? 1 : 0}`);
      aggregatedAlertMetricsLines.push("");
    }

    const aggregatedAlertMetrics = aggregatedAlertMetricsLines.join("\n");
    const metrics = `${queueMetrics}\n${webhookMetrics}\n${secretMetrics}\n${githubApiMetrics}\n${sshMetrics}\n${webhookSecurityMetrics}\n${virtualizorMetrics}\n${adminApiSecurityMetrics}\n${rateLimitMetrics}\n${deploymentCompensationMetrics}\n${aggregatedAlertMetrics}`;
    return reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(metrics);
  });
}
