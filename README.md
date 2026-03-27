# kumpeapps-deployment-bot

GitHub-driven Docker deployment automation with MariaDB control plane.

## Quick Links

- **Admin Dashboard:** `GET /admin` (web UI for RBAC, users, queue, secrets)
- **API Documentation:** See [Initial API Endpoints](#initial-api-endpoints) below
- **User Configuration:** See [User Guide](docs/user-guide.md)
- **Operations:** See [Operator Runbook](docs/operator-runbook.md)

## Documentation

**For repository owners deploying applications:**
- Start with [docs/user-guide.md](docs/user-guide.md) for deployment config and workflows.

**For platform operators and maintainers:** 
- Admin Dashboard: `GET /admin` (web UI with RBAC, user provisioning, queue monitoring)
- Operations runbook: [docs/operator-runbook.md](docs/operator-runbook.md)
- Project roadmap: [ROADMAP.md](ROADMAP.md)

## Quick Start (Developers)

1. Copy environment file:
	- `cp .env.example .env`
2. Install dependencies:
	- `npm install`
3. Generate Prisma client:
	- `npm run prisma:generate`
4. Start MariaDB and bot with Docker Compose:
	- `docker compose up --build`

## Local Development

1. Start database only:
	- `docker compose up mariadb`
2. Run migrations in Docker (recommended in this workspace):
	- `docker run --rm --network kumpeapps-deployment-bot_default -v "$PWD":/app -w /app -e DATABASE_URL="mysql://root:root@mariadb:3306/kumpeapps_bot" -e NODE_ENV=development node:22-bullseye sh -lc "npm install && npx prisma migrate dev"`
3. Start bot in watch mode:
	- `npm run dev`
4. Run tests:
	- `npm run test` (requires Node in your shell)
	- `npm run test:docker` (recommended in this workspace)
5. Run smoke checks against a running service:
	- `npm run smoke:test`
6. Release candidate process reference:
	- `docs/release-candidate-checklist.md`
7. Generate release notes scaffold from git history:
	- `npm run release:notes -- rc-YYYYMMDD.N`
8. Operator runbook reference:
	- `docs/operator-runbook.md`
9. Apply migrations in containerized runtime:
	- `docker compose run --rm bot npm run prisma:deploy`

## CI/CD Container Publishing

GitHub Actions publishes the bot image to GHCR via [publish workflow](.github/workflows/publish-ghcr.yml).

Tag policy:

1. Release publish event:
	- pushes `<release-tag>` and `latest`
2. Push/merge to `main`:
	- pushes `latest-rc`
3. Other branches:
	- pushes `alpha-{ticket}` where `{ticket}` is extracted from `#<number>` in branch name
	- fallback when no `#<number>` is present: `alpha-<short-sha>`

Requirements:

1. Repository Actions must allow `packages: write`.
2. No custom GHCR secret is needed for same-repo publishing; workflow uses `secrets.GITHUB_TOKEN`.

## GitHub App + Server Setup

This service consumes GitHub webhooks and syncs repo configs/secrets for deployment execution.

### 1) Create GitHub App

1. In GitHub: `Settings` -> `Developer settings` -> `GitHub Apps` -> `New GitHub App`.
2. Set webhook URL to your bot endpoint:
	- `https://<your-bot-domain>/github/webhook`
3. Set webhook secret:
	- generate a strong random secret and set the same value in `GITHUB_APP_WEBHOOK_SECRET` on the server.
4. Configure permissions (minimum required):
	- **Repository permissions:**
		- `Contents`: Read (to read deployment configs)
		- `Secrets`: Read (to read Actions secrets)
		- `Deployments`: Write (if using GitHub Deployments API)
	- **Organization permissions:** (none required for basic operation)
5. Subscribe to events your deployment flow needs (minimum):
	- `Push`
	- `Installation`
	- `Installation repositories`
6. After creation:
	- Note the **App ID** (shown at the top of the app settings page)
	- Generate and download a **Private key** (scroll to "Private keys" section)
	- Set these values in your server environment (see step 2 below)
7. Install the app on target repositories/org.

### 2) Repository Token Provisioning & Secret Sync

The bot automatically provisions per-repository API tokens for secure secret synchronization:

**How it works:**
1. When the GitHub App is installed, the bot generates a unique token for each repository
2. Token is encrypted using TweetNaCl sealed box (NaCl encryption)
3. Token is pushed to the repository as `KUMPEAPPS_DEPLOY_BOT_TOKEN` secret
4. Provisioning runs at startup and hourly for resilience

**Using the GitHub Action:**

Repositories can sync secrets using the provided action:

```yaml
name: Sync Secrets
on: [workflow_dispatch, push]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kumpeapps/kumpeapps-deployment-bot@v1
        env:
          KUMPEAPPS_DEPLOY_BOT_TOKEN: ${{ secrets.KUMPEAPPS_DEPLOY_BOT_TOKEN }}
          DB_PASSWORD_SECRET: ${{ secrets.DB_PASSWORD_SECRET }}
```

**Configuration:**
- `REPOSITORY_TOKEN_PROVISIONING_ENABLED=true` - Enable auto-provisioning (default: true)
- `REPOSITORY_TOKEN_PROVISIONING_INTERVAL_MS=3600000` - Provisioning interval (default: 1 hour)

See [README-ACTION.md](README-ACTION.md) for complete action documentation.

### 3) Configure Server Environment

Set or verify the following env vars on the bot server:

1. Core runtime:
	- `APP_PUBLIC_BASE_URL`
	- `DATABASE_URL`
	- `GITHUB_APP_WEBHOOK_SECRET`
2. GitHub API access (recommended - automatic token generation):
	- `GITHUB_APP_ID` - Your GitHub App's numeric ID
	- `GITHUB_APP_PRIVATE_KEY` - Private key content (embed with \n for newlines), OR
	- `GITHUB_APP_PRIVATE_KEY_PATH` - Path to `.pem` file downloaded from GitHub
	- The bot will automatically generate installation tokens (valid 1 hour, auto-refreshed)
	- **Legacy alternative:** Set `GITHUB_API_TOKEN` with a Personal Access Token
		- Less secure; only use if GitHub App auth is not feasible
		- Tokens do not auto-refresh and have broader permissions
	- **Optional:** `BOT_USER_TOKEN` - Personal Access Token for kumpeapps-bot-deploy user account
		- Enables auto-accepting collaborator invitations on personal repositories
		- Required scope: `repo` (full control of private repositories)
		- Without this, initialization issues/PRs won't be assigned until invitation is manually accepted
3. Admin login (GUI):
	- `ADMIN_GITHUB_USERNAME`
	- `GITHUB_OAUTH_CLIENT_ID`
	- `GITHUB_OAUTH_CLIENT_SECRET`
	- callback URL in OAuth app must be: `<APP_PUBLIC_BASE_URL>/admin/auth/github/callback`
4. SSH deploy access:
	- `VM_SSH_USER`, `VM_SSH_KEY_PATH`
	- `CADDY_SSH_USER`, `CADDY_SSH_KEY_PATH`
	- `SSH_KNOWN_HOSTS_PATH`
	- `CADDY_RELOAD_COMMAND`
5. Optional provider (if using Virtualizor API mode):
	- `VIRTUALIZOR_MODE=api`
	- `VIRTUALIZOR_API_URL` (e.g., `https://your-virtualizor-host:4085`)
	- `VIRTUALIZOR_API_KEY`
	- `VIRTUALIZOR_API_PASS`
	- `VIRTUALIZOR_DEFAULT_PLAN` (provider-expected plan identifier)

### 4) Connect GHCR Image to Server

1. Pull image from GHCR:
	- `ghcr.io/<owner>/<repo>:latest-rc` for main branch candidate
	- `ghcr.io/<owner>/<repo>:latest` for release
2. Ensure server can authenticate to GHCR:
	- `docker login ghcr.io` with a token that has package read access.
3. Deploy or restart service with updated image tag.

### 5) Validate End-to-End

1. Confirm webhook endpoint health:
	- `GET /health`
2. Confirm webhook deliveries are being recorded:
	- `GET /api/admin/webhook-deliveries?limit=20`
3. Trigger config sync:
	- `POST /api/admin/repositories/:repositoryOwner/:repositoryName/sync-configs`
4. Trigger test deployment (dry-run first):
	- `POST /api/deployments/execute`

## Current Status

Phase 0 foundation has been scaffolded:

1. Node.js + TypeScript service container.
2. Fastify service with health and webhook endpoints.
3. Prisma + MariaDB schema for core control-plane entities.

## Initial API Endpoints

1. Health check:
	- `GET /health` - returns status, deployment queue stats, and webhook delivery idempotency stats
	- `GET /health/db` - database reachability check
	- `GET /metrics` - Prometheus-compatible queue + webhook delivery metrics for monitoring integration
2. **Admin Dashboard (Web UI):**
	- `GET /admin` - interactive admin panel for RBAC, users, queue, deployments, and secrets
3. GitHub webhook receiver:
	- `POST /github/webhook`
3. User registration:
	- `POST /api/register`
	- body: `{ "githubUsername": "example-user" }`
4. Admin approval and provisioning:
	- `POST /api/admin/users/:githubUsername/approve`
	- header: `x-admin-token: <ADMIN_API_TOKEN>`
	- body: `{ "maxDomains": 10, "maxVms": 2, "approvedDomains": ["example.com", "*.example.com"] }`
5. User governance management:
	- `GET /api/admin/users/:githubUsername`
	- `PUT /api/admin/users/:githubUsername/policy`
	- `POST /api/admin/users/:githubUsername/suspend`
	- `POST /api/admin/users/:githubUsername/reactivate`
6. Repository secret upsert (used for env_mappings resolution):
	- `POST /api/admin/repository-secrets/upsert`
	- header: `x-admin-token: <ADMIN_API_TOKEN>`
	- body: `{ "repositoryOwner": "owner", "repositoryName": "repo", "name": "SECRET_KEY", "value": "secret-value" }`
	- values are encrypted at rest using `SECRET_ENCRYPTION_KEY`
	- **Note:** The bot attempts to resolve secrets in this order:
		1. GitHub Actions repository secrets API (if GitHub App or `GITHUB_API_TOKEN` is configured)
		2. Local encrypted DB store (fallback when API is unavailable or secret not in GitHub)
7. Repository config sync from GitHub:
	- `POST /api/admin/repositories/:repositoryOwner/:repositoryName/sync-configs`
	- header: `x-admin-token: <ADMIN_API_TOKEN>`
	- body: `{ "ref": "main" }`
	- scans `.kumpeapps-deploy-bot/dev|stage|prod/**/*.yml|yaml`
	- validates with deployment config schema and upserts into `deployment_configs`
	- for private repositories, configure GitHub App authentication (see step 2 above)
8. Secret encryption rotation operation:
	- `POST /api/admin/operations/rotate-secret-encryption`
	- header: `x-admin-token: <ADMIN_API_TOKEN>`
	- body: `{ "oldPassphrase": "optional", "newPassphrase": "optional", "dryRun": true }`
	- operation is recorded in `audit_events`
9. Webhook delivery cleanup operation:
	- `POST /api/admin/operations/cleanup-webhook-deliveries`
	- header: `x-admin-token: <ADMIN_API_TOKEN>`
	- manually prunes old webhook delivery idempotency records
	- deletes old `processed` and stale `failed` deliveries
	- operation is recorded in `audit_events`
10. Deployment query APIs:
	- `GET /api/deployments?repositoryOwner=<owner>&repositoryName=<repo>&limit=20`
	- `GET /api/deployments/:id`
11. Deployment job query APIs:
	- `GET /api/deployment-jobs?status=queued|running|succeeded|failed&limit=50`
	- `GET /api/deployment-jobs/:id`
	- `POST /api/deployment-jobs/:id/requeue` - Requeue a failed job for retry
		- header: `x-admin-token: <ADMIN_API_TOKEN>`
		- body: `{ "reason": "reason for requeue" }`
		- returns HTTP 202 with updated job if successful
	- `POST /api/admin/deployment-jobs/cleanup`
		- header: `x-admin-token: <ADMIN_API_TOKEN>`
		- manually triggers cleanup of old deployment job records (succeeded/failed only)
		- returns count deleted and cutoff date applied
		- removes jobs older than `DEPLOY_QUEUE_JOB_RETENTION_DAYS` (default: 30 days)
12. Queue monitoring dashboard:
	- `GET /api/admin/queue-stats` - Detailed queue metrics and health indicators
		- header: `x-admin-token: <ADMIN_API_TOKEN>`
		- includes current state, last-hour activity, retry insights, timeout insights, health estimation, alert booleans (`requiresAttention`, `requiresAttentionEffective`, `queueDepthHigh`, `successRateLow`, `timeoutFailuresHigh`), and suppression info (`isSnoozed`, `snoozedUntil`)
13. Queue alert suppression APIs:
	- `GET /api/admin/queue-alerts?limit=20`
		- header: `x-admin-token: <ADMIN_API_TOKEN>`
		- returns active suppression window and recent suppression history
	- `POST /api/admin/queue-alerts/snooze`
		- header: `x-admin-token: <ADMIN_API_TOKEN>`
		- body: `{ "reason": "planned maintenance", "minutes": 60 }`
		- creates temporary alert suppression window
	- `POST /api/admin/queue-alerts/unsnooze`
		- header: `x-admin-token: <ADMIN_API_TOKEN>`
		- body: `{ "reason": "maintenance complete" }` (optional reason)
		- clears active suppression immediately
	- `POST /api/admin/queue-alerts/cleanup`
		- header: `x-admin-token: <ADMIN_API_TOKEN>`
		- manually triggers cleanup of expired snooze records
		- returns count deleted and cutoff date applied
		- records older than `DEPLOY_QUEUE_ALERT_SNOOZE_RETENTION_DAYS` are removed (default: 90 days)

14. Webhook delivery inspection APIs:
	- `GET /api/admin/webhook-deliveries?status=in_progress|processed|failed&limit=50`
		- header: `x-admin-token: <ADMIN_API_TOKEN>`
		- returns tracked webhook deliveries with idempotency counters
	- `GET /api/admin/webhook-deliveries/:deliveryId`
		- header: `x-admin-token: <ADMIN_API_TOKEN>`
		- returns one tracked webhook delivery by GitHub delivery id

15. Audit event query API:
	- `GET /api/admin/audit-events?action=<optional>&resourceType=<optional>&limit=50`
16. RBAC role binding management APIs (owner role only):
	- `GET /api/admin/rbac/role-bindings?limit=50`
	- `POST /api/admin/rbac/role-bindings/upsert`
		- header: `x-admin-token: <OWNER_TOKEN>`
		- body: `{ "token": "...", "role": "owner|operator|auditor", "description": "optional" }`
	- `POST /api/admin/rbac/role-bindings/deactivate`
		- header: `x-admin-token: <OWNER_TOKEN>`
		- body: `{ "tokenHash": "<sha256 hex>" }`
17. Deployment config schema and policy validation:
	- `POST /api/config/validate`
	- header: `x-admin-token: <ADMIN_API_TOKEN>`
	- body includes `config`, `approvedDomains`, `maxDomains`, `maxVms`, `currentVmCount`
	- supports YAML string or JSON object config input
18. Deployment execution:
	- `POST /api/deployments/execute`
	- header: `x-admin-token: <ADMIN_API_TOKEN>`
	- optional body field: `timeoutMs` (max 7200000) to override per-job timeout
	- enqueues a durable deployment job and returns `jobId`
	- stores `deployments` and `deployment_steps`
	- optionally creates GitHub Deployment + statuses (`in_progress`, `success`, `failure`)
	- when enabled, status updates include `log_url` pointing to `/api/deployments/:id`
	- stores `secrets_resolution_audit` records from `env_mappings`
	- stores `caddy_releases` records with caddy config checksums
	- validates policy + user quotas + domains before execution
	- resolves env mapping secret values from `repository_secrets`
	- idempotent per repository/environment/config/commit (reuses existing deployment record)
	- non-dry-run uses SSH/SCP with env keys from `.env`
	- VM ensure supports Virtualizor modes: `dryrun`, `manual`, `api`
	- when `DEPLOY_EXECUTION_DRY_RUN_ONLY=true`, non-dry-run calls are blocked

## Admin Dashboard

Access the web-based admin interface at `GET /admin` (GitHub OAuth login).

**Features:**

1. **Dashboard Tab**
	- Queue stats (depth, success rate, recent trends)
	- Recent deployments list with status
2. **RBAC Tab**
	- View active role bindings (owner, operator, auditor)
	- Create new role bindings for admin tokens
	- Deactivate existing tokens
3. **Users Tab**
	- Approve pending users
	- Set max domains and VMs per user
	- Assign approved domain whitelist
4. **Queue Tab**
	- View detailed queue statistics
	- Monitor running and queued jobs
	- Job details and retry options
5. **Secrets Tab**
	- Upsert repository secrets
	- Encrypted at rest with `SECRET_ENCRYPTION_KEY`

**Access:**
- Login required: sign in with GitHub at `GET /admin/login`
- Only the configured username in `ADMIN_GITHUB_USERNAME` is allowed
- OAuth callback requires:
	- `GITHUB_OAUTH_CLIENT_ID`
	- `GITHUB_OAUTH_CLIENT_SECRET`
	- `APP_PUBLIC_BASE_URL` matching your GitHub OAuth app callback URL
- Session is stored as an `HttpOnly` cookie (`admin_session`)
- API routes still support `x-admin-token` for non-GUI automation

## Reliability Settings

1. SSH execution hardening:
	- `SSH_CONNECT_TIMEOUT_SECONDS` for SSH/SCP command timeout
	- `SSH_COMMAND_RETRIES` for transient network retries
	- `SSH_ALERT_FINAL_FAILURES_1H_HIGH` sets high-failure threshold for SSH/SCP final failures in the last hour
	- `SSH_ALERT_TIMEOUT_FAILURES_1H_HIGH` sets high-failure threshold for SSH/SCP timeout failures in the last hour
	- `SSH_STRICT_HOST_KEY_CHECKING` supports `yes`, `no`, `accept-new`
	- `SSH_KNOWN_HOSTS_PATH` for known hosts file path
	- process-level fatal handlers shut down gracefully on `unhandledRejection` and `uncaughtException`
2. API traffic hardening:
	- `HTTP_ACCESS_LOG_ENABLED` enables explicit structured request start/complete/error logs
	- `RATE_LIMIT_ENABLED` enables global in-memory request limiting
	- `RATE_LIMIT_WINDOW_MS` sets the rolling window size for limits
	- `RATE_LIMIT_MAX_REQUESTS` sets max requests per IP per window for non-webhook routes
	- `RATE_LIMIT_WEBHOOK_MAX_REQUESTS` sets max requests per IP per window for `/github/webhook`
	- admin RBAC supports role-scoped tokens (`owner`, `operator`, `auditor`) via `ADMIN_API_OWNER_TOKEN`, `ADMIN_API_OPERATOR_TOKEN`, `ADMIN_API_AUDITOR_TOKEN`
	- `ADMIN_API_TOKEN` remains a backward-compatible owner token fallback when `ADMIN_API_OWNER_TOKEN` is not set
	- DB-backed token hash bindings are enabled by `ADMIN_RBAC_DB_BINDINGS_ENABLED`
	- startup role bootstrap from env tokens is controlled by `ADMIN_RBAC_BOOTSTRAP_FROM_ENV`
	- unauthorized requests return `401`; authenticated but under-scoped requests return `403`
	- authorization denials are audit-logged as `authz.denied.unauthorized` and `authz.denied.forbidden`
	- `RATE_LIMIT_ALERT_BLOCKED_REQUESTS_1H_HIGH` sets high-failure threshold for blocked requests in last hour
	- `ADMIN_API_ALERT_AUTH_FAILURES_1H_HIGH` sets high-failure threshold for unauthorized `/api/admin/*` requests in last hour
3. Webhook and GitHub API resilience:
	- `WEBHOOK_SYNC_RETRY_ATTEMPTS` controls retry count for push-triggered config sync failures
	- `WEBHOOK_SYNC_RETRY_BASE_DELAY_MS` controls exponential backoff base delay for webhook sync retries
	- `WEBHOOK_DELIVERY_IN_PROGRESS_LEASE_MS` allows reclaiming stale `in_progress` deliveries after lease expiration
	- `WEBHOOK_DELIVERY_RETENTION_DAYS` keeps webhook idempotency records bounded (default: 30 days)
	- `WEBHOOK_ALERT_FAILED_24H_HIGH` threshold for failed webhook deliveries in last 24h
	- `WEBHOOK_ALERT_IN_PROGRESS_HIGH` threshold for currently in-progress webhook deliveries
	- `WEBHOOK_ALERT_STALE_RECLAIMS_24H_HIGH` threshold for stale reclaim events in last 24h
	- `WEBHOOK_ALERT_DUPLICATE_SUPPRESSIONS_24H_HIGH` threshold for duplicate suppression count in last 24h
	- `WEBHOOK_ALERT_INVALID_SIGNATURES_1H_HIGH` threshold for invalid webhook signatures in last hour
	- `GITHUB_API_POST_MAX_RETRIES` controls retry count for transient GitHub Deployment API failures (`429`, `5xx`)
	- `GITHUB_API_POST_RETRY_BASE_DELAY_MS` controls exponential backoff base delay for GitHub API retries
	- `GITHUB_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD` opens a circuit after consecutive final failures
	- `GITHUB_API_CIRCUIT_BREAKER_COOLDOWN_MS` keeps circuit open before allowing traffic again
	- `GITHUB_API_ALERT_FINAL_FAILURES_1H_HIGH` sets high-failure alert threshold for final GitHub API failures in the last hour
	- webhook delivery records are pruned on startup and via `POST /api/admin/operations/cleanup-webhook-deliveries`
4. Deployment queue behavior:
	- push and admin-triggered deploy jobs are queued in MariaDB (`deployment_jobs`)
	- `DEPLOY_QUEUE_CONCURRENCY` controls concurrent queued deployment task execution
	- `DEPLOY_QUEUE_POLL_INTERVAL_MS` controls worker polling frequency
	- `DEPLOY_QUEUE_RUNNING_LEASE_MS` requeues stale `running` jobs after lease timeout
	- `DEPLOY_QUEUE_JOB_TIMEOUT_MS` sets default per-job execution timeout (milliseconds)
	- `DEPLOY_QUEUE_JOB_RETENTION_DAYS` sets how long to keep completed job history (default: 30 days)
		- only succeeded/failed jobs older than this are pruned (queued/running jobs are kept)
		- old records are pruned on startup and via `POST /api/admin/deployment-jobs/cleanup`
	- `DEPLOY_QUEUE_ALERT_QUEUE_DEPTH_HIGH` sets queue depth alert threshold
	- `DEPLOY_QUEUE_ALERT_SUCCESS_RATE_MIN_PERCENT` sets minimum acceptable last-hour success rate
	- `DEPLOY_QUEUE_ALERT_TIMEOUT_FAILURES_24H_HIGH` sets timeout-failure count threshold for last 24 hours
	- `DEPLOY_QUEUE_ALERT_LEASE_RECLAIMS_24H_HIGH` sets stale-running-job reclaim threshold for last 24 hours
	- `DEPLOY_QUEUE_ALERT_USER_REQUEUES_24H_HIGH` sets manual job requeue threshold for last 24 hours
	- `DEPLOY_QUEUE_ALERT_MAX_SNOOZE_MINUTES` sets max duration for manual alert suppression window
	- `DEPLOY_QUEUE_ALERT_SNOOZE_RETENTION_DAYS` sets how long to keep snooze history records (default: 90 days)
		- expired records older than this are pruned on startup and via `POST /api/admin/queue-alerts/cleanup`
	- failed jobs can be manually requeued via `POST /api/deployment-jobs/:id/requeue` (returns HTTP 202)
	- queue stats visible in `GET /health` under `deploymentQueue` (`queued`, `running`, `failed`, `succeeded`)
	- detailed monitoring available at `GET /api/admin/queue-stats` (success rates, retry insights, timeout distribution, health estimation, alert suppression state)
	- alert suppression status/history available at `GET /api/admin/queue-alerts`
	- Prometheus metrics available at `GET /metrics` for integration with monitoring systems, including alert-ready 0/1 flags and snooze-aware effective alert state
5. Secret encryption health visibility:
	- secret decrypt failures are isolated per secret during resolution and rotation operations
	- `SECRET_ENCRYPTION_ALERT_DECRYPT_FAILURES_1H_HIGH` sets a high-failure threshold for decrypt failures in the last hour
	- `GET /health` includes `secretEncryption` stats (`decryptFailuresTotal`, `decryptFailuresLastHour`, `lastDecryptFailureAt`, `fallbackKeysConfigured`)
	- `GET /health` includes secret encryption alert flags (`decryptFailuresLastHourHigh`, `requiresAttention`) and thresholds
	- `GET /metrics` includes `secret_encryption_decrypt_failures_total`, `secret_encryption_decrypt_failures_1hour`, `secret_encryption_fallback_keys_configured`, and alert flags
6. Virtualizor API mode behavior:
	- `VIRTUALIZOR_API_TIMEOUT_MS` for API request timeout
	- `VIRTUALIZOR_CREATE_ENABLED=true|false` to allow API mode auto-create
	- `VIRTUALIZOR_DEFAULT_PLAN`, `VIRTUALIZOR_DEFAULT_REGION`, `VIRTUALIZOR_DEFAULT_OS` for create payload defaults
	- `VIRTUALIZOR_ALERT_API_FAILURES_1H_HIGH` sets high-failure threshold for Virtualizor API failures in last hour
	- `VIRTUALIZOR_ALERT_VM_READY_TIMEOUTS_1H_HIGH` sets high-failure threshold for VM ready-state polling timeouts in last hour
	- `VIRTUALIZOR_VM_READY_POLL_INTERVAL_MS` and `VIRTUALIZOR_VM_READY_TIMEOUT_MS` to wait for `running` VM state after create
	- `GET /health` includes `virtualizor` stats and alert flags
	- `GET /metrics` includes Virtualizor counters and alert flags (`virtualizor_*`)
	- `GET /health` includes aggregated system alert rollup (`state`, `alerts.requiresAttention`, `alerts.sources`)
	- `GET /metrics` includes aggregated system alert gauges (`system_alert_*`)
	- `GET /health` includes `adminApiSecurity` stats (auth failures, missing token failures, alert flags)
	- `GET /metrics` includes admin API security counters and alert flags (`admin_api_*`)
	- `GET /health` includes `rateLimit` stats (blocked totals, blocked webhook totals, alert flags)
	- `GET /metrics` includes rate-limit counters and alert flags (`rate_limit_*`)
7. GitHub deployment status integration:
	- `GITHUB_DEPLOYMENTS_ENABLED=true|false` to enable GitHub Deployments API status updates
	- requires GitHub App authentication with Deployments: Write permission (or legacy `GITHUB_API_TOKEN`)
	- set `APP_PUBLIC_BASE_URL` so GitHub `log_url` points to a reachable bot URL
	- stores GitHub deployment ID in `deployments.github_deployment_id`
	- `GET /health` includes `githubApi` stats (consecutive failures, circuit open state, final failure counts, alert flags)
	- `GET /metrics` includes GitHub API counters and alert flags (`github_api_*`)
8. SSH execution observability:
	- `GET /health` includes `ssh` stats (attempts, retries, success/failure totals, last success/failure timestamps, and alert flags)
	- `GET /metrics` includes SSH counters and alert flags (`ssh_commands_*`, `ssh_alert_*`)
9. Deployment compensation observability:
	- failed deployments run a compensation plan and persist compensation steps under `compensation.*`
	- `DEPLOY_COMPENSATION_VM_COMPOSE_DOWN_ENABLED` enables best-effort `docker compose down` compensation on the target VM
	- `DEPLOY_COMPENSATION_ALERT_FAILURES_24H_HIGH` sets high-failure threshold for compensation failures in last 24 hours
	- Caddy deploy performs best-effort rollback to previous remote files when validation/reload fails
	- `CADDY_VALIDATE_COMMAND` can be configured for post-apply validation before reload (empty means skipped)
	- `GET /health` includes `deploymentCompensation` stats (`totals`, `last24h`, and alert flags)
	- `GET /metrics` includes compensation counters and alert flags (`deployment_compensation_*`)

## Auto Deploy From Push

1. Enable with envs:
	- `AUTO_DEPLOY_ENABLED=true`
	- `AUTO_DEPLOY_DRY_RUN=true|false`
	- `AUTO_DEPLOY_CADDY_HOST=<host>`
2. On `push` webhook events, bot:
	- syncs configs from GitHub into `deployment_configs` for the pushed commit SHA
	- loads stored `deployment_configs` for the repository
	- evaluates `deploy_rules` branch include/exclude per environment
	- executes matching deployments with commit SHA from push payload

## Webhook Persistence Status

1. GitHub App installation events persist to MariaDB:
	- `installation.created`
	- `installation.deleted`
	- `installation_repositories.added`
	- `installation_repositories.removed`
2. Webhook delivery idempotency is enforced in MariaDB:
	- deliveries are tracked in `github_webhook_deliveries` by GitHub `x-github-delivery`
	- `processed` and `in_progress` duplicates are suppressed with HTTP 202 (`duplicate: true`)
	- stale `in_progress` deliveries are automatically reclaimed after `WEBHOOK_DELIVERY_IN_PROGRESS_LEASE_MS`
	- failed deliveries are allowed to retry on the same delivery id
	- webhook signature is verified before delivery tracking is used
3. Webhook delivery observability:
	- `/health` includes webhook delivery totals and 24h status counts
	- `/metrics` includes Prometheus metrics for processed/failed/in-progress deliveries
	- `/metrics` includes counters for duplicate suppressions and stale reclaims
	- `/health` includes `webhookSecurity` stats for invalid signature monitoring and alert flags
	- `/metrics` includes webhook security counters and alert flags (`webhook_security_*`)

## Contribution Workflow

1. Start with issue and PR templates:
	- use issue templates for `bug`, `hardening`, and `decision` work items
	- use the PR template to provide test evidence and operational impact notes
2. Required release checks for deployment-affecting changes:
	- run `npm run build`
	- run `npm run test` or `npm run test:docker`
	- run `npm run smoke:test` against a running service
	- record migration impact in PR (`none`, `backward-compatible`, or `coordination required`)
3. Required rollback safety checks:
	- document rollback path in PR description
	- verify fail-safe behavior for partial deployment failures
	- update `docs/operator-runbook.md` when operational behavior changes
4. Before merging release-related changes:
	- follow `docs/release-candidate-checklist.md`
	- generate release notes scaffold with `npm run release:notes -- <release-tag>`