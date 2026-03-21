# Release Candidate Checklist

Use this checklist when preparing a release candidate for the deployment bot.

## Preconditions

1. Branch is up to date and tests are green.
2. `.env` is configured for target environment.
3. Database backup/snapshot exists for rollback safety.

## 1. Build and Tag

1. Build the image:
   - `docker compose build bot`
2. Create release candidate git tag (example):
   - `git tag -a rc-YYYYMMDD.N -m "Release candidate rc-YYYYMMDD.N"`
3. Push branch and tag:
   - `git push`
   - `git push origin rc-YYYYMMDD.N`

## 2. Migration Dry Run (Staging-like)

1. Run deploy migrations in containerized runtime:
   - `docker compose run --rm bot npm run prisma:deploy`
2. Confirm migration completion in logs.

## 3. Smoke Suite

1. Ensure service is running:
   - `docker compose up -d mariadb bot`
2. Run baseline smoke checks:
   - `npm run smoke:test`
3. Optional extended checks (signed webhook ping):
   - `SMOKE_EXTENDED=true WEBHOOK_SECRET=<secret> npm run smoke:test`

Smoke suite currently validates:

1. `GET /health`
2. `GET /health/db`
3. `GET /metrics` (aggregated alert metric present)
4. `POST /api/register`
5. Admin checks when `ADMIN_API_TOKEN` is provided:
   - `GET /api/admin/queue-stats`
   - `GET /api/admin/queue-alerts`
   - `GET /api/admin/audit-events`
6. Optional `POST /github/webhook` ping when `SMOKE_EXTENDED=true` and `WEBHOOK_SECRET` is set.

## 4. Release Notes

1. Generate release notes scaffold:
   - `npm run release:notes -- rc-YYYYMMDD.N`
   - output defaults to `docs/releases/rc-YYYYMMDD.N.md`
2. Optional custom output path:
   - `npm run release:notes -- rc-YYYYMMDD.N docs/releases/custom-name.md`
1. Summarize changes from last tag:
   - key features
   - migrations
   - new/changed env variables
   - operational notes
2. Link roadmap milestone and known risks.

Template reference:

- `docs/templates/release-notes-template.md`

## 5. Go/No-Go Criteria

1. Build succeeds.
2. Migrations succeed.
3. Smoke suite passes.
4. No open Sev-1 or Sev-2 regressions.
