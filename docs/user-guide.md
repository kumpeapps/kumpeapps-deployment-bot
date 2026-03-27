# KumpeApps Deployment Bot User Guide

Welcome! This guide is for repository owners who want to deploy applications using the KumpeApps Deployment Bot.

## Quick Start

The deployment bot automates Docker Compose deployments to virtual machines using repository configuration files.

1. **Ask your admin** for repository access and to provision your user.
2. **Create a config folder** in your repository: `.kumpeapps-deploy-bot/`
3. **Add environment folders**: `dev/`, `stage/`, `prod/`
4. **Write deployment configs** (YAML files) in those folders.
5. **Push to GitHub** and trigger deployments via admin API or webhook.

## Repository Setup

### Step 1: Install the GitHub App

The KumpeApps Deployment Bot runs as a GitHub App. To get started:

1. Ask your admin to install the app on your repository
2. The bot will automatically:
   - Generate a unique API token for your repository
   - Encrypt the token using TweetNaCl sealed box (NaCl encryption)
   - Push it to your repository as `KUMPEAPPS_DEPLOY_BOT_TOKEN` secret
3. This token is used for automatic secret synchronization (see Step 4 below)

### Step 2: Create the Config Folder Structure

```
your-repo/
└── .kumpeapps-deploy-bot/
    ├── dev/
    ├── stage/
    └── prod/
```

### Step 3: Create Your First Deployment Config

Create `.kumpeapps-deploy-bot/dev/my-app.yml`:

```yaml
deployment_type: docker
assigned_username: your-github-username
vm_hostname: dev-vm-01
plan_name: premium  # Optional: Use named plan instead of default
domains:
  - myapp.example.dev
docker_compose:
  version: '3.8'
  services:
    web:
      image: myapp:latest
      ports:
        - "3000:3000"
      environment:
        NODE_ENV: development
        DATABASE_URL: mysql://user:pass@db:3306/mydb
caddy:
  - |
    myapp.example.dev {
      reverse_proxy localhost:3000
    }
env_mappings:
  DATABASE_PASSWORD: DB_PASSWORD_SECRET
deploy_rules:
  - environment: dev
    branches:
      include: [develop]
      exclude: []
```

> **Note:** This config is for the dev environment. Create similar configs in `.kumpeapps-deploy-bot/stage/` and `.kumpeapps-deploy-bot/prod/` for other environments, adjusting the `environment` field and branch rules accordingly.

### Step 4: Sync Your Secrets

The bot needs access to your secrets to inject them during deployment. Use the provided GitHub Action:

**Create `.github/workflows/sync-secrets.yml`:**

```yaml
name: Sync Secrets

on:
  workflow_dispatch:  # Manual trigger
  push:
    paths:
      - '.kumpeapps-deploy-bot/**'  # Auto-sync when configs change

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: kumpeapps/kumpeapps-deployment-bot@v1
        env:
          # This token is auto-created by the bot when the app is installed
          KUMPEAPPS_DEPLOY_BOT_TOKEN: ${{ secrets.KUMPEAPPS_DEPLOY_BOT_TOKEN }}
          # Pass all your secrets - they'll all be synced:
          DB_PASSWORD_SECRET: ${{ secrets.DB_PASSWORD_SECRET }}
```

**Add your application secrets to GitHub:**

1. Go to Settings → Secrets and variables → Actions
2. Add `DB_PASSWORD_SECRET` (or whatever secrets your `env_mappings` references)
3. Run the workflow manually or push to trigger it

**How it works:**
- The action syncs ALL secrets you pass as environment variables
- No config parsing - simple and predictable
- Each deployment config specifies which secrets it needs in `env_mappings`
- Bot injects only the secrets specified in that config during deployment

**Why list secrets in the workflow?**

Due to GitHub Actions security, you must pass secrets as environment variables. **The action syncs everything you pass** to the bot's database. Then each deployment config uses only the secrets it needs via its `env_mappings` section.

For more details, see [README-ACTION.md](../README-ACTION.md).

## Configuration Reference

### Required Fields

| Field | Description | Example |
|-------|-------------|---------|
| `deployment_type` | Must be `docker` | `docker` |
| `assigned_username` | Your GitHub username | `your-username` |
| `vm_hostname` | Target VM hostname | `prod-vm-01` |
| `domains` | Domains to serve traffic to | `["example.com", "api.example.com"]` |
| `docker_compose` | Compose file path or inline content | See below |
| `caddy` | Caddy config file paths or inline content | See Caddy section |
| `env_mappings` | Map env vars to GitHub repository secrets | `DATABASE_URL: DB_SECRET_NAME` |
| `deploy_rules` | Branch/tag rules to trigger deployment | See deploy_rules section |

### Optional Fields

| Field | Description | Example |
|-------|-------------|---------|
| `plan_name` | Named plan for custom VM resources (must be configured by admin) | `premium` |
| `ssh_port` | Custom SSH port for VM | `2222` |
| `caddy_ssh_port` | Custom SSH port for Caddy VM | `2223` |

**Plan Names:** Contact your admin to create named plans with specific resource allocations (RAM, disk, CPU cores) for different environments. If not specified, environment-specific defaults are used.

### Docker Compose

**Recommended: Use file references**

Place your docker-compose.yml in the same directory as your deployment config and reference it:

```yaml
docker_compose: docker-compose.yml
```

Paths are resolved relative to the deployment config file:
- `docker-compose.yml` or `./docker-compose.yml` - Same directory as config
- `../docker-compose.yml` - Parent directory
- `/path/from/repo/root.yml` - Absolute from repository root

**Backwards compatible: Inline content**

You can also define Docker services inline:

```yaml
docker_compose: |
  version: '3.8'
  services:
    web:
      image: myapp:latest
      ports:
        - "3000:3000"
    db:
      image: postgres:15
      environment:
        POSTGRES_PASSWORD: $DB_PASSWORD
```

**Automatic Managed Nebula Client Injection**

The bot automatically injects a Managed Nebula VPN client service into every deployment. This service is added as the first service in your compose file:

```yaml
services:
  client:  # Automatically added by the bot
    image: ghcr.io/kumpeapps/managed-nebula/client:kumpeapps
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun
    environment:
      SERVER_URL: https://nebula.kumpedns.us:4200/api
      CLIENT_TOKEN: ${NEBULA_CLIENT_TOKEN}  # Automatically provided
      POLL_INTERVAL_HOURS: 1
    network_mode: host
  # Your services follow...
  web:
    image: myapp:latest
```

**You don't need to manually add this service** - it's injected during deployment. The `NEBULA_CLIENT_TOKEN` is automatically provided as a repository secret.

### Caddy Reverse Proxy Configuration

**Recommended: Use file references**

Define one or more Caddyfile blocks by referencing files:

```yaml
caddy:
  main: caddyfile
  api: api-caddyfile
```

**Important:** Files are deployed with unique names to avoid conflicts between repositories. The bot automatically generates names like: `{owner}-{env}-{repo}-{yourFileName}`. Files without extensions get `.caddy` added automatically. For example:
- `kumpeapps-dev-myapp-main.caddy` (from `main: caddyfile`)
- `acme-prod-api-gateway-main.caddy` (from `main: caddyfile` in different repo)
- `kumpeapps-stage-myapp-api.conf` (from `api: api.conf` - extension preserved)

This ensures multiple repos can deploy to the same Caddy server without overwriting each other's configs.

**Backwards compatible: Inline content**

Or define inline Caddyfile blocks:

```yaml
caddy:
  main: |
    example.com www.example.com {
      reverse_proxy {{vm.ip}}:3000
    }
  api: |
    api.example.com {
      reverse_proxy {{nebula.ip}}:8000
    }
```

**Placeholders:**
- `{{vm.ip}}` - Replaced with the VM's IP address
- `{{nebula.ip}}` - Replaced with the Nebula VPN IP address for the environment (from `{ENV}_NEBULA_IP` secret)

Features:
- Automatic HTTPS with Let's Encrypt
- Load balancing and failover
- Request routing and rewriting
- Full Caddy directive support

**Important:** Domains in Caddy config must match domains in the `domains` list and be in your approved domain list.

### Environment Mappings

Connect your application's environment variables to GitHub repository secrets:

```yaml
env_mappings:
  DATABASE_URL: DB_CONNECTION_STRING
  API_KEY: THIRD_PARTY_API_KEY
  JWT_SECRET: JWT_SECRET_KEY
```

**Automatically available secrets:**

The following secrets are automatically created when the bot is installed:
- `KUMPEAPPS_DEPLOY_BOT_TOKEN` - Authentication token for the bot
- `DEV_NEBULA_CLIENT_TOKEN` - Nebula VPN token for dev environment
- `DEV_NEBULA_IP` - Nebula VPN IP address for dev environment
- `STAGE_NEBULA_CLIENT_TOKEN` - Nebula VPN token for stage environment
- `STAGE_NEBULA_IP` - Nebula VPN IP address for stage environment
- `PROD_NEBULA_CLIENT_TOKEN` - Nebula VPN token for prod environment
- `PROD_NEBULA_IP` - Nebula VPN IP address for prod environment

**How secrets are synced:**

1. Add secrets to GitHub (Settings → Secrets → Actions)
2. Create a sync workflow using the `kumpeapps-deployment-bot` action (see Step 4 above)
3. Run the workflow to sync secrets to the bot
4. Bot injects them during deployment

**Security:**
- Repository tokens are unique and scoped per repository
- Tokens are encrypted with TweetNaCl sealed box before being pushed to GitHub
- Secrets are encrypted at rest in the bot's database using `SECRET_ENCRYPTION_KEY`
- Secrets are never logged or exposed in deployment records
- Token provisioning runs automatically at startup and hourly for resilience

### Deploy Rules

Control when deployments happen based on branches, PR labels, or release events. Since configs are organized by environment folders (`.kumpeapps-deploy-bot/dev/`, `.kumpeapps-deploy-bot/stage/`, `.kumpeapps-deploy-bot/prod/`), each config file should define rules for **only its own environment**.

Deploy rules support three trigger types:
- **Branch-based**: Deploy when code is pushed to matching branches
- **Label-based**: Deploy when a PR receives a specific label (auto-removes from other PRs)
- **Release-based**: Deploy when a GitHub release is published

#### Branch-Based Deployment

**Dev config example** (`.kumpeapps-deploy-bot/dev/myapp.yml`):

```yaml
deploy_rules:
  - environment: dev
    branches:
      include:
        - develop
        - feature/**
      exclude: []
```

**Stage config example** (`.kumpeapps-deploy-bot/stage/myapp.yml`):

```yaml
deploy_rules:
  - environment: stage
    branches:
      include:
        - main
        - release/**
      exclude: []
```

**Prod config example** (`.kumpeapps-deploy-bot/prod/myapp.yml`):

```yaml
deploy_rules:
  - environment: prod
    branches:
      include:
        - main
      exclude:
        - feature/**
        - develop
```

Branch patterns support glob syntax (`feature/**`, `release-*`). If no rules match a push, deployment is skipped.

#### Label-Based Deployment

Deploy specific PRs by adding a label. Perfect for dev environments where you want manual control over which PR is deployed.

**How it works:**
1. Add the configured label (e.g., `deploy-dev`) to any PR
2. Bot automatically removes the label from all other open PRs
3. Every subsequent push to that PR triggers deployment automatically
4. Only one PR can be deployed at a time (enforced by label cleanup)

**Dev config example with label trigger (any branch)**:

```yaml
deploy_rules:
  - environment: dev
    labels:
      - deploy-dev
      - preview-deploy
```

**With optional branch filtering**:

```yaml
deploy_rules:
  - environment: dev
    labels:
      - deploy-dev
    branches:
      include:
        - feature/**
      exclude:
        - main
```

**Usage**: 
- Add the `deploy-dev` label to any PR
- Bot removes `deploy-dev` from any other PRs
- Every push to that PR's branch deploys to dev
- Remove the label or close the PR to stop deployments

**Note**: Branch patterns are optional. Without them, any PR with the label will deploy regardless of branch name. With branch patterns, the PR's branch must match the `include`/`exclude` rules even if it has the label.

#### Release-Based Deployment

Deploy when GitHub releases are published. Useful for production deployments tied to releases.

**Prod config example with release trigger**:

```yaml
deploy_rules:
  - environment: prod
    release:
      types:
        - published
      exclude_prerelease: true
```

**Options**:
- `types`: Array of release event types (`published`, `created`, `released`, `edited`)
  - `published`: Default - when you publish a draft release or create a new release
  - `created`: When a release is first created
  - `released`: Legacy alternative to `published`
  - `edited`: When an existing release is editedexclude_prerelease`: If `true`, pre-releases are skipped (default: `false`)

**Usage**: Create a release in GitHub (not a pre-release if `exclude_prerelease: true`) to trigger production deployment.

#### Combining Multiple Trigger Types

You can combine different trigger types in one config:

```yaml
deploy_rules:
  - environment: prod
    labels:
      - deploy-prod
      - emergency-hotfix
    branches:
      include:
        - main
    release:
      types:
        - published
      exclude_prerelease: true
```

This config deploys to prod when:
- A release is published (not pre-release), OR
- Code is pushed to `main`, OR
- A PR receives the `deploy-prod` or `emergency-hotfix` label

## Triggering Deployments

### Manual Deployment (Admin API)

Ask your admin to run:

```bash
curl -X POST http://bot-api/api/deployments/execute \
  -H "x-admin-token: <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "repositoryOwner": "your-org",
    "repositoryName": "your-repo",
    "environment": "dev",
    "configPath": ".kumpeapps-deploy-bot/dev/my-app.yml",
    "commitSha": "abc123def456"
  }'
```

Response:

```json
{
  "jobId": "job-uuid",
  "deploymentId": "deploy-uuid",
  "message": "Deployment queued"
}
```

### Webhook-Triggered Deployment (Push)

If `AUTO_DEPLOY_ENABLED=true`, deployments run automatically on push when deploy rules match.

## Monitoring Deployments

### Check Deployment Status

```bash
# List recent deployments
curl http://bot-api/api/deployments \
  -H "x-admin-token: <ADMIN_TOKEN>" \
  -G --data-urlencode "repositoryOwner=your-org" \
  -G --data-urlencode "repositoryName=your-repo" \
  -G --data-urlencode "limit=20"

# Get specific deployment details
curl http://bot-api/api/deployments/<deployment-id> \
  -H "x-admin-token: <ADMIN_TOKEN>"
```

Response includes:
- `status`: `queued`, `running`, `succeeded`, `failed`
- `steps`: individual deployment steps (VM ensure, compose deploy, Caddy deploy)
- `logs`: diagnostic output per step

### Check Job Queue

```bash
curl http://bot-api/api/admin/queue-stats \
  -H "x-admin-token: <OPERATOR_TOKEN>"
```

Responses include queue depth, success rates, and alert indicators.

## Common Deployment Scenarios

### Scenario 1: Simple Web App

Deploy a Node.js web app to development:

```yaml
# .kumpeapps-deploy-bot/dev/webapp.yml
deployment_type: docker
assigned_username: alice
vm_hostname: dev-vm-01
domains:
  - webapp.example.dev

docker_compose:
  version: '3.8'
  services:
    app:
      image: mycompany/webapp:latest
      ports:
        - "3000:3000"
      environment:
        NODE_ENV: development
        DATABASE_URL: $DATABASE_URL
        API_KEY: $API_KEY

caddy:
  - |
    webapp.example.dev {
      reverse_proxy localhost:3000
    }

env_mappings:
  DATABASE_URL: DEV_DATABASE_URL
  API_KEY: DEV_API_KEY

deploy_rules:
  - environment: dev
    branches:
      include: [develop]
      exclude: []
```

Push to `develop` branch → deployment runs automatically.

### Scenario 2: Multi-Environment (Dev, Stage, Prod)

Create separate configs for each environment:

**Development** (`.kumpeapps-deploy-bot/dev/api.yml`):
```yaml
deployment_type: docker
assigned_username: alice
vm_hostname: dev-vm-api
domains: [api.example.dev]
docker_compose:
  version: '3.8'
  services:
    api:
      image: mycompany/api:latest
      ports: ["8000:8000"]
      environment:
        LOG_LEVEL: debug
env_mappings:
  DATABASE_URL: DEV_DB_URL
deploy_rules:
  - environment: dev
    branches:
      include: [develop, feature/**]
      exclude: []
```

**Stage** (`.kumpeapps-deploy-bot/stage/api.yml`):
```yaml
deployment_type: docker
assigned_username: alice
vm_hostname: stage-vm-api
domains: [api-stage.example.com]
docker_compose:
  # Similar to dev, but may use different image tag/config
# ... 
deploy_rules:
  - environment: stage
    branches:
      include: [main, release/**]
      exclude: []
```

**Production** (`.kumpeapps-deploy-bot/prod/api.yml`):
```yaml
deployment_type: docker
assigned_username: alice
vm_hostname: prod-vm-api
domains: [api.example.com]
docker_compose:
  # Production-grade config
# ...
deploy_rules:
  - environment: prod
    branches:
      include: [main]
      exclude: [develop, feature/**]
```

### Scenario 3: Database Migration with App Deployment

If your app needs schema migrations on deploy:

```yaml
docker_compose:
  version: '3.8'
  services:
    migrate:
      image: mycompany/api:latest
      command: npm run migrate
      environment:
        DATABASE_URL: $DATABASE_URL
      depends_on:
        - db
    api:
      image: mycompany/api:latest
      ports: ["8000:8000"]
      command: npm run start
      depends_on:
        - db
    db:
      image: postgres:15
      environment:
        POSTGRES_PASSWORD: $DB_PASS
```

Docker Compose will run `migrate` service before `api` service due to `depends_on` ordering.

## Troubleshooting

### Deployment Fails with "Domain not approved"

**Cause:** Domain in Caddy config is not in your approved domains list.

**Fix:** 
1. Ask admin to add the domain to your approved domains.
2. Verify the domain in deployment config `domains` list matches Caddy config.

### Deployment Fails with "Secret ${SECRET_NAME} not resolved"

**Cause:** An env mapping references a secret that hasn't been synced to the bot.

**Fix:**
1. Verify the secret exists in GitHub (Settings → Secrets → Actions)
2. Verify the secret name in `env_mappings` matches exactly
3. Run your sync workflow (`.github/workflows/sync-secrets.yml`)
4. If `KUMPEAPPS_DEPLOY_BOT_TOKEN` is missing:
   - Check that the GitHub App is installed on your repository
   - Wait a few minutes for the bot to auto-provision the token
   - Check bot logs if the token still doesn't appear

### Deployment Succeeds but App Doesn't Start

**Cause:** Docker image not found, or services fail to start.

**Fix:**
1. Verify image tag is correct and published (e.g., `docker pull mycompany/api:latest`).
2. Check environment variables in `env_mappings` are all set.
3. View deployment logs from admin API response or ask admin to check VM logs.

### Caddy Reload Fails

**Cause:** Caddy config syntax error or port conflict.

**Fix:**
1. Validate Caddy syntax locally: `caddy validate --config /path/to/caddy-file`
2. Ensure reverse_proxy targets match exposed Docker ports.
3. Ask admin to check if port (e.g., 80, 443) is already in use on the VM.

### Deployment is Stuck in "Running"

**Cause:** Long-running deployment step or timeout.

**Fix:**
1. Ask admin to check `GET /api/admin/queue-stats`.
2. If job is stuck, admin can manually requeue it.
3. Increase `DEPLOY_QUEUE_JOB_TIMEOUT_MS` if deployments legitimately take >30 minutes.

## Best Practices

1. **Use separate configs per environment**
   - Dev, stage, and prod should have distinct configs, VM targets, and domain lists.
   - Avoid copy-paste; use templates or shared compose base files if possible.

2. **Test locally first**
   - Run `docker-compose -f compose-file.yml up` locally to catch errors before VM deployment.
   - Use `caddy validate` to check reverse proxy config.

3. **Keep secrets off the repo**
   - Never hardcode secrets in deployment configs or Caddy files.
   - Always use `env_mappings` to reference GitHub secrets.

4. **Use meaningful image tags**
   - Avoid `latest` if you need reproducible deployments.
   - Consider `myapp:commit-sha` or `myapp:v1.2.3` for traceability.

5. **Monitor after deployment**
   - Deployment success ≠ app health.
   - Check health endpoints or logs to confirm app is running correctly.

6. **Document domain requirements**
   - List required domains in your repo README.
   - Inform admin of new domains before deployment.

7. **Test rollback procedures**
   - Confirm you can quickly revert to a previous release if needed.
   - Document manual rollback steps in your repository.

## FAQ

**Q: Can I deploy multiple apps from one repository?**
A: Yes. Create separate config files in each environment folder (e.g., `dev/backend.yml`, `dev/frontend.yml`).

**Q: Can I use environment variables not from secrets?**
A: Yes, but hardcoded values should be non-sensitive. Use `docker_compose` environment section for fixed config.

**Q: How do I update a secret value?**
A: Update the secret in GitHub (Settings → Secrets → Actions), then re-run your sync workflow. The bot will update its encrypted copy.

**Q: Is the auto-provisioned KUMPEAPPS_DEPLOY_BOT_TOKEN secure?**
A: Yes. Each repository gets a unique token that:
- Is scoped to only that repository (can't access other repos)
- Is encrypted with TweetNaCl sealed box before being pushed to GitHub
- Is automatically rotated if the token is deleted or the app is reinstalled
- Only has permission to sync secrets for that specific repository

**Q: What happens if a deployment partially fails?**
A: The bot attempts compensation (e.g., rolling back Caddy config, stopping incomplete Docker services). Check deployment logs for details.

**Q: How do I trigger a deployment manually?**
A: Ask your admin to use the admin API `POST /api/deployments/execute` endpoint.

**Q: Can I restrict who can deploy?**
A: Yes. The bot uses GitHub RBAC and admin token scoping. Only users with owner role can modify deployment configs and trigger deployments.

**Q: How long do deployments take?**
A: Typically 2-5 minutes for a small app (VM ensure + image pull + compose up + Caddy reload).

**Q: What if I need to store secrets not in GitHub?**
A: The bot uses GitHub repository secrets as the primary source. For advanced cases, your admin can manually add secrets via the admin API. For most use cases, GitHub secrets with the sync workflow is recommended.

## Next Steps

1. **Install the GitHub App** on your repository (ask your admin)
2. **Create your config folder** in your repository
3. **Write your first deployment config** using the examples above
4. **Create a secret sync workflow** (`.github/workflows/sync-secrets.yml`)
5. **Add your secrets** to GitHub repository secrets
6. **Run the sync workflow** to sync secrets to the bot
7. **Push to GitHub** and monitor the deployment
8. **Check `/api/deployments`** to see deployment history and status

## Support and Escalation

For issues or questions:
1. Check the troubleshooting section above.
2. Ask your admin to review deployment logs via the admin API.
3. Contact your platform owner if there are operational concerns.

---

**Last updated:** 2026-03-15  
**Config version:** v1  
**For operators:** See [docs/operator-runbook.md](../operator-runbook.md) and [ROADMAP.md](../ROADMAP.md)  
**For secret sync details:** See [README-ACTION.md](../README-ACTION.md) and [secret-sync-guide.md](secret-sync-guide.md)
