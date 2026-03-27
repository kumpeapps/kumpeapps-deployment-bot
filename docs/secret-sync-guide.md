# Secret Synchronization Guide

## Overview

The deployment bot needs access to repository secrets to inject them as environment variables during deployment. Since GitHub's API doesn't expose secret VALUES (only metadata), secrets must be synced using GitHub Actions workflows.

## How It Works

1. **Token Auto-Provisioning** (automatic):
   - When GitHub App is installed, bot generates unique repository token
   - Token is encrypted using TweetNaCl sealed box (NaCl encryption)
   - Token is pushed to repository as `KUMPEAPPS_DEPLOY_BOT_TOKEN` secret
   - This happens automatically at startup and hourly for resilience

2. **Secrets are stored in GitHub** (Settings → Secrets → Actions)

3. **GitHub Actions workflow syncs secrets** using the auto-provisioned token

4. **Bot injects secrets** as environment variables during deployment

## Setup (Per Repository)

### Step 1: Install GitHub App

Install the KumpeApps Deployment Bot GitHub App on your repository. The bot will automatically create the `KUMPEAPPS_DEPLOY_BOT_TOKEN` secret within minutes.

### Step 2: Create Sync Workflow

Create `.github/workflows/sync-secrets.yml`:

```yaml
name: Sync Secrets

on:
  workflow_dispatch:
  push:
    paths: ['.kumpeapps-deploy-bot/**']

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: kumpeapps/kumpeapps-deployment-bot@v1
        env:
          KUMPEAPPS_DEPLOY_BOT_TOKEN: ${{ secrets.KUMPEAPPS_DEPLOY_BOT_TOKEN }}
          # Pass all your secrets - they'll all be synced:
          DB_PASSWORD_SECRET: ${{ secrets.DB_PASSWORD_SECRET }}
```

See [docs/examples/repo-sync-secrets-simple.yml](./examples/repo-sync-secrets-simple.yml) for a complete example.

### Understanding Secret Listing

**Q: Why do I need to list secrets in the workflow?**

GitHub Actions security prevents dynamic secret access (`${{ secrets[varName] }}`). **The action syncs everything you pass:**

- 📤 Syncs ALL secrets passed as environment variables
- 🎯 No config parsing - simple and predictable
- 🔧 Each deployment config uses what it needs via `env_mappings`

**You list all your secrets once** in the workflow, and:
1. Action syncs all of them to the bot's database
2. Each deployment config specifies which secrets it needs in `env_mappings`
3. Bot injects only the secrets specified in that config's `env_mappings`

**Example:**
- You pass `DB_SECRET`, `API_SECRET`, and `NEBULA_TOKEN` in the workflow
- All three are synced to the bot
- Dev config has `env_mappings: { DB_PASS: DB_SECRET }` → gets only DB_SECRET
- Prod config has `env_mappings: { DB_PASS: DB_SECRET, API_KEY: API_SECRET }` → gets both

### Step 3: Run the Workflow

1. Go to Actions → Sync Secrets → Run workflow
2. Or push a change to `.kumpeapps-deploy-bot/` configs

## Important Notes

### GitHub Limitation

You **must explicitly list each secret** in the workflow file. GitHub Actions doesn't allow:
- Dynamic secret access (e.g., `${{ secrets[secretName] }}`)
- Iterating over all secrets
- Auto-discovering secrets

### Security

- Repository tokens are unique per repository (cannot access other repos)
- Tokens are encrypted using TweetNaCl sealed box before being pushed to GitHub
- The sync workflow has access to secret values only for its own repository
- Secrets are encrypted in the bot's database using `SECRET_ENCRYPTION_KEY`
- Repository tokens use `kdbt_` prefix and only work for their specific repository

### When to Sync

Sync secrets when:
- ✅ Adding/updating secrets in GitHub
- ✅ Changing `env_mappings` in deployment config
- ✅ First-time repository setup

You don't need to sync before every deployment - secrets are cached in the bot's database.

## Troubleshooting

### Deployment fails with "Missing repository secret values"

The secret hasn't been synced to the bot. Run the sync workflow.

### Sync workflow fails with 401

`KUMPEAPPS_DEPLOY_BOT_TOKEN` is missing or incorrect. Check:
1. Is the GitHub App installed on your repository?
2. Check Settings → Secrets → Actions for the token
3. Check bot logs for token provisioning errors
4. The bot runs token provisioning at startup and hourly

### Sync workflow fails with 404

Repository not registered with the bot. Install the GitHub App first.

## Alternative Methods

### Using Admin Token (Advanced)

For administrative access or bulk operations, you can use the admin API token directly:

```bash
curl -X POST "http://preprod-deployment-bot.mdhome.net:3000/api/admin/repository-secrets/upsert" \
  -H "Authorization: Bearer ${ADMIN_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "repositoryOwner": "owner",
    "repositoryName": "repo",
    "name": "SECRET_NAME",
    "value": "secret-value"
  }'
```

See [docs/examples/sync-secrets-workflow.yml](./examples/sync-secrets-workflow.yml) for a curl-based workflow example.

### Manual Secret Management

You can also add secrets via the bot's admin UI:

1. Navigate to `http://preprod-deployment-bot.mdhome.net:3000/admin/`
2. Click "New repository secret"
3. Fill in repository owner, name, secret name, and value
4. Click "Create"

This is useful for:
- One-off testing
- Secrets that aren't in GitHub (e.g., API keys from other systems)
- Emergency secret updates without pushing to GitHub
