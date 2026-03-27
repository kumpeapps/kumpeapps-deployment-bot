/**
 * Sync Secrets Workflow Generator
 * 
 * Generates GitHub Actions workflow for syncing secrets to VMs
 */

/**
 * Generate sync-secrets workflow YAML content
 * 
 * @param managedNebulaEnabled - whether Nebula-managed networking is enabled for this repository
 */
export function generateSyncSecretsWorkflow(managedNebulaEnabled: boolean): string {
  const getNebulaSecrets = () => {
    if (!managedNebulaEnabled) {
      return `          # Nebula VPN is not enabled for this repository.
          # To enable Nebula-based networking, contact your deployment bot administrator
          # and request Nebula client provisioning for this repository.
          # DEV_NEBULA_CLIENT_TOKEN: \${{ secrets.DEV_NEBULA_CLIENT_TOKEN }}
          # STAGE_NEBULA_CLIENT_TOKEN: \${{ secrets.STAGE_NEBULA_CLIENT_TOKEN }}
          # PROD_NEBULA_CLIENT_TOKEN: \${{ secrets.PROD_NEBULA_CLIENT_TOKEN }}`;
    }
    return `          # Development environment secrets
          DEV_DEPLOY_BOT_TOKEN: \${{ secrets.DEV_DEPLOY_BOT_TOKEN }}
          DEV_NEBULA_CLIENT_TOKEN: \${{ secrets.DEV_NEBULA_CLIENT_TOKEN }}
          
          # Staging environment secrets
          STAGE_DEPLOY_BOT_TOKEN: \${{ secrets.STAGE_DEPLOY_BOT_TOKEN }}
          STAGE_NEBULA_CLIENT_TOKEN: \${{ secrets.STAGE_NEBULA_CLIENT_TOKEN }}
          
          # Production environment secrets
          PROD_DEPLOY_BOT_TOKEN: \${{ secrets.PROD_DEPLOY_BOT_TOKEN }}
          PROD_NEBULA_CLIENT_TOKEN: \${{ secrets.PROD_NEBULA_CLIENT_TOKEN }}`;
  };

  return `name: Sync Secrets to Deployment Bot

# This workflow automatically syncs repository secrets to the deployment bot.
# The action will sync ALL secrets passed as environment variables, regardless
# of what's in your deployment config.
#
# Behavior:
# - ALL secrets passed in the env section are synced to the bot
# - You don't need to maintain a list of which secrets each config needs
# - The bot will use the appropriate secrets based on each deployment config's env_mappings
#
# The KUMPEAPPS_DEPLOY_BOT_TOKEN is automatically created by the bot when
# the GitHub App is installed on your repository.

on:
  workflow_dispatch: # Manual trigger
  push:
    branches: [main, develop]
    paths:
      - '.kumpeapps-deploy-bot/**/*.yml'
      - '.github/workflows/sync-secrets.yml'

jobs:
  sync-secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Sync secrets to deployment bot
        uses: kumpeapps/kumpeapps-deployment-bot@main
        env:
          # Bot token (auto-created when GitHub App is installed)
          KUMPEAPPS_DEPLOY_BOT_TOKEN: \${{ secrets.KUMPEAPPS_DEPLOY_BOT_TOKEN }}
          
          # All your application secrets - just pass them all here.
          # The action syncs everything you pass, and each deployment config
          # will use only the secrets it needs via its env_mappings section.
          
${getNebulaSecrets()}
          
          # Add your other application secrets below:
          # DB_PASSWORD: \${{ secrets.DB_PASSWORD }}
          # API_KEY: \${{ secrets.API_KEY }}
`;
}
