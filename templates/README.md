# Deployment Configuration Templates

This folder contains the source templates used during repository initialization.

## Files

- `dev-example.yml.template` - Dev environment example with PR label-based deployment
- `stage-example.yml.template` - Stage environment example with main branch deployment
- `prod-example.yml.template` - Prod environment example with release-based deployment
- `gitleaks.toml.template` - Secret scanner configuration to prevent false positives
- `gitleaksignore.template` - Ignore list for template files
- `deployment-config-template.yml` - Generic reference template only (not used by init PR generation)

## How Initialization Uses These Files

When the deployment bot initializes a repository, it reads the env-specific source templates from this folder and creates:

- `.kumpeapps-deploy-bot/dev/dev-example.yml.template`
- `.kumpeapps-deploy-bot/stage/stage-example.yml.template`
- `.kumpeapps-deploy-bot/prod/prod-example.yml.template`

It also creates:

- `.github/workflows/sync-secrets.yml`
- `.gitleaks.toml`
- `.gitleaksignore`

Users should copy a `.template` file and remove the extension for real configs:

```bash
cp .kumpeapps-deploy-bot/dev/dev-example.yml.template .kumpeapps-deploy-bot/dev/myapp.yml
```

The `.template` extension prevents workflow validation and secret scanners from treating examples as real config.

## Example Trigger Patterns

- `dev-example.yml.template`: PR label `deploy-dev` + every push to that PR
- `stage-example.yml.template`: Push to `main`
- `prod-example.yml.template`: Release published (excluding pre-releases)

## Modifying Init Templates

To change what the init PR adds to repositories, edit:

- `dev-example.yml.template`
- `stage-example.yml.template`
- `prod-example.yml.template`

These files are loaded by `loadEnvironmentTemplates()` in `src/services/repository-initialization.ts`.
