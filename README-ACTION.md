# KumpeApps Deployment Bot - GitHub Action

Automatically sync repository secrets from GitHub to the KumpeApps deployment bot.

## Features

- 🔑 **Sync all passed secrets** from workflow env variables
- 🚀 **Simple setup** - just use the action, token is auto-provisioned
- 🔒 **Secure** - uses per-repository API tokens, not admin tokens
- 📝 **Audit trail** - all secret operations are logged

## Quick Start

### Prerequisites

1. **Install the GitHub App** on your repository
2. **Wait for token provisioning** (the bot automatically creates `KUMPEAPPS_DEPLOY_BOT_TOKEN` secret)
3. **Add your application secrets** to GitHub (Settings → Secrets → Actions)

### Step 2: Create Workflow

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
          # Pass all your secrets here - the action syncs everything provided
          DB_PASSWORD_SECRET: ${{ secrets.DB_PASSWORD_SECRET }}
          # Add your other secrets here
```

### Step 3: Run Workflow

Go to Actions → Sync Secrets → Run workflow

## How It Works

1. **Token Provisioning** (automatic):
   - When GitHub App is installed, bot generates unique repository token
   - Token is encrypted using TweetNaCl sealed box (NaCl encryption)
   - Token is pushed to repository as `KUMPEAPPS_DEPLOY_BOT_TOKEN` secret
   - Token only works for that specific repository (not admin access)
   - Provisioning runs at startup and hourly for resilience

2. **Secret Sync** (automatic):
  - Action reads all passed environment variables
  - Filters out system/GitHub runtime variables
  - Syncs remaining values as repository secrets in the bot

3. **Deployment** (automatic):
   - Bot reads each deployment config's `env_mappings`
   - Injects only the secrets specified in that config as environment variables
   - Secrets are encrypted at rest in bot's database

**Why do I need to list secrets in the workflow?**

<<<<<<< HEAD
GitHub Actions security prevents dynamic secret access (e.g., `${{ secrets[varName] }}`). The action syncs everything you pass:
- 📤 Syncs ALL secrets passed as environment variables
- 🎯 Each deployment config uses what it needs via `env_mappings`
- 🔄 One workflow serves all environments
=======
GitHub Actions security prevents dynamic secret access (e.g., `${{ secrets[varName] }}`). The action syncs whatever secrets you explicitly pass in `env`.
>>>>>>> 33daf68 ([bug/#16] Fixed Sync Secrets logic)

## Configuration

### Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `bot-url` | Deployment bot URL | `https://deploy.kumpe.app` |
| `bot-token` | Override token (uses `KUMPEAPPS_DEPLOY_BOT_TOKEN` if not provided) | `` |

### Example: Syncing All Secrets

```yaml
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kumpeapps/kumpeapps-deployment-bot@v1
        env:
          KUMPEAPPS_DEPLOY_BOT_TOKEN: ${{ secrets.KUMPEAPPS_DEPLOY_BOT_TOKEN }}
          # Pass all your secrets - the action syncs everything provided
          DEV_DEPLOY_BOT_TOKEN: ${{ secrets.DEV_DEPLOY_BOT_TOKEN }}
          DEV_NEBULA_CLIENT_TOKEN: ${{ secrets.DEV_NEBULA_CLIENT_TOKEN }}
          PROD_DEPLOY_BOT_TOKEN: ${{ secrets.PROD_DEPLOY_BOT_TOKEN }}
          PROD_NEBULA_CLIENT_TOKEN: ${{ secrets.PROD_NEBULA_CLIENT_TOKEN }}
          DB_PASSWORD_SECRET: ${{ secrets.DB_PASSWORD_DEV }}
```

## Important Notes

### GitHub Actions Security Requirement

Due to GitHub Actions security, you **must pass secrets as environment variables** in the workflow. The action cannot dynamically access `${{ secrets[varName] }}`.

**Best practice:** Pass only the secrets you want stored for that repository.

### Token Security

- Each repository gets its own unique token (prefix: `kdbt_`)
- Tokens are scoped to the specific repository only
- Tokens cannot access other repositories' secrets
- Tokens cannot perform admin operations

### When to Sync

Sync secrets when:
- ✅ Adding/updating secrets in GitHub
- ✅ First-time repository setup

You don't need to sync before every deployment - secrets are cached in the bot's database.

## Troubleshooting

### "No bot token provided"

The `KUMPEAPPS_DEPLOY_BOT_TOKEN` secret hasn't been created. This should happen automatically when the GitHub App is installed. Check:
1. Is the GitHub App installed on your repository?
2. Check repository Settings → Secrets → Actions for the token
3. Check bot logs for token provisioning errors

### "No secrets found in environment variables to sync"

No custom secrets were passed in your workflow `env` block.

**Fix:** Add secrets explicitly:
```yaml
env:
  KUMPEAPPS_DEPLOY_BOT_TOKEN: ${{ secrets.KUMPEAPPS_DEPLOY_BOT_TOKEN }}
  XYZ: ${{ secrets.XYZ }}
```

### "Failed to sync secret (HTTP 401)"

The repository token is invalid. Try:
1. Reinstall the GitHub App on the repository
2. Check bot logs for token generation errors

### "Failed to sync secret (HTTP 404)"

Repository not registered with the bot. Install the GitHub App first.

## Development

### Testing Locally

```bash
# Run the action locally (requires act)
act -s GITHUB_TOKEN=$(gh auth token) \
    -s KUMPEAPPS_DEPLOY_BOT_TOKEN=your-token \
    -s DB_PASSWORD_SECRET=test-value
```

### Manual Token Generation

For testing, you can manually create a repository token:
```sql
UPDATE repositories 
SET apiToken = 'kdbt_test-token-here' 
WHERE owner = 'owner' AND name = 'repo';
```

## License

MIT
