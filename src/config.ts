import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

// Custom boolean parser for environment variables
// envBoolean() incorrectly converts string "false" to true
const envBoolean = () =>
  z
    .union([z.boolean(), z.string(), z.number()])
    .transform((val) => {
      if (typeof val === "boolean") return val;
      if (typeof val === "number") return val !== 0;
      if (typeof val === "string") {
        const lower = val.toLowerCase().trim();
        if (lower === "true" || lower === "1" || lower === "yes") return true;
        if (lower === "false" || lower === "0" || lower === "no" || lower === "") return false;
        throw new Error(`Invalid boolean value: ${val}`);
      }
      return false;
    });

// Custom optional number parser that handles empty strings
const envOptionalNumber = () =>
  z.preprocess((val) => {
    if (val === "" || val === undefined || val === null) return undefined;
    return val;
  }, z.coerce.number().int().positive().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  HTTP_ACCESS_LOG_ENABLED: envBoolean().default(true),
  RATE_LIMIT_ENABLED: envBoolean().default(true),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(240),
  RATE_LIMIT_WEBHOOK_MAX_REQUESTS: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_ALERT_BLOCKED_REQUESTS_1H_HIGH: z.coerce.number().int().nonnegative().default(100),
  DATABASE_URL: z.string().min(1),
  GITHUB_API_TOKEN: z.string().default(""),
  GITHUB_OAUTH_CLIENT_ID: z.string().default(""),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().default(""),
  GITHUB_API_POST_MAX_RETRIES: z.coerce.number().int().nonnegative().max(5).default(2),
  GITHUB_API_POST_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(300),
  GITHUB_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  GITHUB_API_CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(60000),
  GITHUB_API_ALERT_FINAL_FAILURES_1H_HIGH: z.coerce.number().int().nonnegative().default(10),
  GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default(""),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
  BOT_USER_TOKEN: z.string().default(""),
  ADMIN_API_TOKEN: z.string().min(1),
  ADMIN_GITHUB_USERNAME: z.string().default(""),
  ADMIN_SESSION_SECRET: z.string().default(""),
  ADMIN_API_OWNER_TOKEN: z.string().default(""),
  ADMIN_API_OPERATOR_TOKEN: z.string().default(""),
  ADMIN_API_AUDITOR_TOKEN: z.string().default(""),
  ADMIN_RBAC_DB_BINDINGS_ENABLED: envBoolean().default(true),
  ADMIN_RBAC_BOOTSTRAP_FROM_ENV: envBoolean().default(true),
  ADMIN_API_ALERT_AUTH_FAILURES_1H_HIGH: z.coerce.number().int().nonnegative().default(20),
  WEBHOOK_SYNC_RETRY_ATTEMPTS: z.coerce.number().int().nonnegative().max(5).default(2),
  WEBHOOK_SYNC_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(300),
  WEBHOOK_DELIVERY_IN_PROGRESS_LEASE_MS: z.coerce.number().int().positive().default(300000),
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  WEBHOOK_ALERT_FAILED_24H_HIGH: z.coerce.number().int().nonnegative().default(20),
  WEBHOOK_ALERT_IN_PROGRESS_HIGH: z.coerce.number().int().nonnegative().default(10),
  WEBHOOK_ALERT_STALE_RECLAIMS_24H_HIGH: z.coerce.number().int().nonnegative().default(5),
  WEBHOOK_ALERT_DUPLICATE_SUPPRESSIONS_24H_HIGH: z.coerce.number().int().nonnegative().default(100),
  WEBHOOK_ALERT_INVALID_SIGNATURES_1H_HIGH: z.coerce.number().int().nonnegative().default(20),
  DEPLOY_EXECUTION_DRY_RUN_ONLY: envBoolean().default(true),
  DEPLOY_QUEUE_CONCURRENCY: z.coerce.number().int().positive().max(20).default(1),
  DEPLOY_QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  DEPLOY_QUEUE_RUNNING_LEASE_MS: z.coerce.number().int().positive().default(900000),
  DEPLOY_QUEUE_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(1800000),
  DEPLOY_QUEUE_JOB_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  DEPLOY_QUEUE_ALERT_QUEUE_DEPTH_HIGH: z.coerce.number().int().nonnegative().default(20),
  DEPLOY_QUEUE_ALERT_SUCCESS_RATE_MIN_PERCENT: z.coerce.number().min(0).max(100).default(80),
  DEPLOY_QUEUE_ALERT_TIMEOUT_FAILURES_24H_HIGH: z.coerce.number().int().nonnegative().default(5),
  DEPLOY_QUEUE_ALERT_LEASE_RECLAIMS_24H_HIGH: z.coerce.number().int().nonnegative().default(5),
  DEPLOY_QUEUE_ALERT_USER_REQUEUES_24H_HIGH: z.coerce.number().int().nonnegative().default(10),
  DEPLOY_QUEUE_ALERT_MAX_SNOOZE_MINUTES: z.coerce.number().int().positive().max(7 * 24 * 60).default(240),
  DEPLOY_QUEUE_ALERT_SNOOZE_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  DEPLOY_COMPENSATION_VM_COMPOSE_DOWN_ENABLED: envBoolean().default(true),
  DEPLOY_COMPENSATION_ALERT_FAILURES_24H_HIGH: z.coerce.number().int().nonnegative().default(3),
  VM_SSH_USER: z.string().default("root"),
  VM_SSH_KEY_PATH: z.string().default("/root/.ssh/id_rsa"),
  VM_SSH_PORT: z.coerce.number().int().positive().default(22),
  VM_DEPLOY_BASE_DIR: z.string().default("/opt/kumpeapps"),
  DEPLOYMENT_SERVICE_NAME: z.string().default("kumpeapps-bot-deployment"),
  SSH_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(15),
  SSH_COMMAND_RETRIES: z.coerce.number().int().nonnegative().max(5).default(2),
  SSH_ALERT_FINAL_FAILURES_1H_HIGH: z.coerce.number().int().nonnegative().default(10),
  SSH_ALERT_TIMEOUT_FAILURES_1H_HIGH: z.coerce.number().int().nonnegative().default(3),
  SSH_STRICT_HOST_KEY_CHECKING: z.enum(["yes", "no", "accept-new"]).default("accept-new"),
  SSH_KNOWN_HOSTS_PATH: z.string().default("/root/.ssh/known_hosts"),
  CADDY_SSH_USER: z.string().default("root"),
  CADDY_SSH_KEY_PATH: z.string().default("/root/.ssh/id_rsa"),
  CADDY_SSH_PORT: z.coerce.number().int().positive().default(22),
  CADDY_CONFIG_DIR: z.string().default("/etc/caddy/sites-enabled"),
  CADDY_VALIDATE_COMMAND: z.string().default(""),
  CADDY_RELOAD_COMMAND: z.string().default("sudo systemctl reload caddy"),
  VIRTUALIZOR_MODE: z.enum(["dryrun", "manual", "api"]).default("dryrun"),
  VIRTUALIZOR_API_URL: z.string().default(""),
  VIRTUALIZOR_API_KEY: z.string().default(""),
  VIRTUALIZOR_API_PASS: z.string().default(""),
  VIRTUALIZOR_API_INSECURE: envBoolean().default(false),
  VIRTUALIZOR_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  VIRTUALIZOR_CREATE_ENABLED: envBoolean().default(true),
  VIRTUALIZOR_DEFAULT_PLAN: z.string().default(""),
  VIRTUALIZOR_DEV_PLAN: z.string().default(""),
  VIRTUALIZOR_STAGE_PLAN: z.string().default(""),
  VIRTUALIZOR_PROD_PLAN: z.string().default(""),
  VIRTUALIZOR_DEFAULT_REGION: z.string().default(""),
  VIRTUALIZOR_DEFAULT_OS: z.string().default(""),
  VIRTUALIZOR_DEFAULT_USER: z.string().default(""), // uid - user who owns the VM
  VIRTUALIZOR_VM_USER_EMAIL: z.string().default("bot@kumpeapps.com"), // Email for VM user account
  VIRTUALIZOR_VM_USER_PASS: z.string().default(""), // Password for VM user account
  VIRTUALIZOR_VM_ROOT_PASS: z.string().default(""), // Root password for VMs
  // Environment-specific server IDs (serid parameter)
  VIRTUALIZOR_DEV_SERVER: z.string().default(""),
  VIRTUALIZOR_STAGE_SERVER: z.string().default(""),
  VIRTUALIZOR_PROD_SERVER: z.string().default(""),
  VIRTUALIZOR_ALERT_API_FAILURES_1H_HIGH: z.coerce.number().int().nonnegative().default(10),
  VIRTUALIZOR_ALERT_VM_READY_TIMEOUTS_1H_HIGH: z.coerce.number().int().nonnegative().default(3),
  VIRTUALIZOR_VM_READY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  VIRTUALIZOR_VM_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(600000), // 10 minutes for OS installation
  VIRTUALIZOR_WEBHOOK_SECRET: z.string().default(""), // Secret for authenticating Virtualizor webhook calls
  GITHUB_WORKFLOW_CHECK_ENABLED: envBoolean().default(true),
  GITHUB_WORKFLOW_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(1800000), // 30 minutes
  GITHUB_WORKFLOW_CHECK_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10000), // 10 seconds
  GITHUB_DEPLOYMENTS_ENABLED: envBoolean().default(false),
  GITHUB_DEPLOYMENT_ERROR_ISSUES_ENABLED: envBoolean().default(true),
  SECRET_ENCRYPTION_KEY: z.string().min(16).default("change-this-secret-key"),
  SECRET_ENCRYPTION_PREVIOUS_KEYS: z.string().default(""),
  SECRET_ENCRYPTION_ALERT_DECRYPT_FAILURES_1H_HIGH: z.coerce.number().int().nonnegative().default(3),
  AUTO_DEPLOY_ENABLED: envBoolean().default(false),
  AUTO_DEPLOY_DRY_RUN: envBoolean().default(true),
  AUTO_DEPLOY_CADDY_HOST: z.string().default("localhost"),
  REPOSITORY_TOKEN_PROVISIONING_ENABLED: envBoolean().default(true),
  REPOSITORY_TOKEN_PROVISIONING_INTERVAL_MS: z.coerce.number().int().positive().default(3600000), // 1 hour
  WEBHOOK_RETRY_ENABLED: envBoolean().default(true),
  WEBHOOK_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  WEBHOOK_RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(300000), // 5 minutes
  // Managed Nebula VPN provisioning
  MANAGED_NEBULA_ENABLED: envBoolean().default(false),
  MANAGED_NEBULA_API_URL: z.string().default(""),
  MANAGED_NEBULA_API_KEY: z.string().default(""),
  MANAGED_NEBULA_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MANAGED_NEBULA_IP_POOL_ID: z.coerce.number().int().positive().default(1),
  MANAGED_NEBULA_IP_GROUP_POOL_ID: envOptionalNumber(),
  // Environment-specific group IDs (comma-separated)
  MANAGED_NEBULA_DEV_GROUP_IDS: z.string().default(""),
  MANAGED_NEBULA_STAGE_GROUP_IDS: z.string().default(""),
  MANAGED_NEBULA_PROD_GROUP_IDS: z.string().default(""),
  // Environment-specific firewall ruleset IDs (comma-separated)
  MANAGED_NEBULA_DEV_FIREWALL_RULE_IDS: z.string().default(""),
  MANAGED_NEBULA_STAGE_FIREWALL_RULE_IDS: z.string().default(""),
  MANAGED_NEBULA_PROD_FIREWALL_RULE_IDS: z.string().default("")
});

// Helper to parse comma-separated IDs into number arrays
function parseIdList(value: string): number[] {
  if (!value || value.trim() === "") return [];
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "")
    .map((id) => {
      const parsed = parseInt(id, 10);
      if (isNaN(parsed)) {
        throw new Error(`Invalid ID in list: ${id}`);
      }
      return parsed;
    });
}

export type AppConfig = Omit<z.infer<typeof EnvSchema>, 
  | 'MANAGED_NEBULA_DEV_GROUP_IDS'
  | 'MANAGED_NEBULA_STAGE_GROUP_IDS'
  | 'MANAGED_NEBULA_PROD_GROUP_IDS'
  | 'MANAGED_NEBULA_DEV_FIREWALL_RULE_IDS'
  | 'MANAGED_NEBULA_STAGE_FIREWALL_RULE_IDS'
  | 'MANAGED_NEBULA_PROD_FIREWALL_RULE_IDS'
> & {
  MANAGED_NEBULA_DEV_GROUP_IDS: number[];
  MANAGED_NEBULA_STAGE_GROUP_IDS: number[];
  MANAGED_NEBULA_PROD_GROUP_IDS: number[];
  MANAGED_NEBULA_DEV_FIREWALL_RULE_IDS: number[];
  MANAGED_NEBULA_STAGE_FIREWALL_RULE_IDS: number[];
  MANAGED_NEBULA_PROD_FIREWALL_RULE_IDS: number[];
};

const parsedEnv = EnvSchema.parse(process.env);

export const appConfig: AppConfig = {
  ...parsedEnv,
  MANAGED_NEBULA_DEV_GROUP_IDS: parseIdList(parsedEnv.MANAGED_NEBULA_DEV_GROUP_IDS),
  MANAGED_NEBULA_STAGE_GROUP_IDS: parseIdList(parsedEnv.MANAGED_NEBULA_STAGE_GROUP_IDS),
  MANAGED_NEBULA_PROD_GROUP_IDS: parseIdList(parsedEnv.MANAGED_NEBULA_PROD_GROUP_IDS),
  MANAGED_NEBULA_DEV_FIREWALL_RULE_IDS: parseIdList(parsedEnv.MANAGED_NEBULA_DEV_FIREWALL_RULE_IDS),
  MANAGED_NEBULA_STAGE_FIREWALL_RULE_IDS: parseIdList(parsedEnv.MANAGED_NEBULA_STAGE_FIREWALL_RULE_IDS),
  MANAGED_NEBULA_PROD_FIREWALL_RULE_IDS: parseIdList(parsedEnv.MANAGED_NEBULA_PROD_FIREWALL_RULE_IDS)
};

// Debug logging for Managed Nebula configuration (only in development)
if (appConfig.MANAGED_NEBULA_ENABLED && process.env.NODE_ENV !== 'production') {
  console.log('[Config] Managed Nebula configuration loaded:');
  console.log(`  - IP_POOL_ID: ${appConfig.MANAGED_NEBULA_IP_POOL_ID}`);
  console.log(`  - IP_GROUP_POOL_ID: ${appConfig.MANAGED_NEBULA_IP_GROUP_POOL_ID ?? 'not set'}`);
  console.log(`  - DEV_GROUP_IDS: [${appConfig.MANAGED_NEBULA_DEV_GROUP_IDS.join(', ')}]`);
  console.log(`  - STAGE_GROUP_IDS: [${appConfig.MANAGED_NEBULA_STAGE_GROUP_IDS.join(', ')}]`);
  console.log(`  - PROD_GROUP_IDS: [${appConfig.MANAGED_NEBULA_PROD_GROUP_IDS.join(', ')}]`);
}
