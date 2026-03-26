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
  const getNebulaEnvVars = (env: string) => {
    if (!managedNebulaEnabled) {
      return `          # Nebula VPN is not enabled for this repository.
          # To enable Nebula-based networking, contact your deployment bot administrator
          # and request Nebula client provisioning for this repository.
          # Nebula secrets (${env}_NEBULA_CLIENT_TOKEN, ${env}_NEBULA_IP) will be created automatically.`;
    }
    return `          # Nebula VPN credentials - auto-created for ${env.toLowerCase()} environment
          ${env}_NEBULA_CLIENT_TOKEN: \${{ secrets.${env}_NEBULA_CLIENT_TOKEN }}
          ${env}_NEBULA_IP: \${{ secrets.${env}_NEBULA_IP }}`;
  };

  return `name: Sync Secrets

on:
  workflow_dispatch:  # Manual trigger
  push:
    paths:
      - '.kumpeapps-deploy-bot/**'  # Auto-sync when configs change

jobs:
  sync-dev-secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync Dev Secrets
        uses: kumpeapps/kumpeapps-deployment-bot@v1-alpha1
        with:
          environment: dev
        env:
          # Bot token - auto-created when the app is installed
          KUMPEAPPS_DEPLOY_BOT_TOKEN: \${{ secrets.KUMPEAPPS_DEPLOY_BOT_TOKEN }}
${getNebulaEnvVars('DEV')}
          # Add your application secrets below:
          # DB_PASSWORD: \${{ secrets.DB_PASSWORD }}
          # API_KEY: \${{ secrets.API_KEY }}

  sync-stage-secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync Stage Secrets
        uses: kumpeapps/kumpeapps-deployment-bot@v1-alpha1
        with:
          environment: stage
        env:
          # Bot token - auto-created when the app is installed
          KUMPEAPPS_DEPLOY_BOT_TOKEN: \${{ secrets.KUMPEAPPS_DEPLOY_BOT_TOKEN }}
${getNebulaEnvVars('STAGE')}
          # Add your application secrets below:
          # DB_PASSWORD: \${{ secrets.DB_PASSWORD }}
          # API_KEY: \${{ secrets.API_KEY }}

  sync-prod-secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync Prod Secrets
        uses: kumpeapps/kumpeapps-deployment-bot@v1-alpha1
        with:
          environment: prod
        env:
          # Bot token - auto-created when the app is installed
          KUMPEAPPS_DEPLOY_BOT_TOKEN: \${{ secrets.KUMPEAPPS_DEPLOY_BOT_TOKEN }}
${getNebulaEnvVars('PROD')}
          # Add your application secrets below:
          # DB_PASSWORD: \${{ secrets.DB_PASSWORD }}
          # API_KEY: \${{ secrets.API_KEY }}
`;
}
