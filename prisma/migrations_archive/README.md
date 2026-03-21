# Migration Consolidation - March 21, 2026

## What Happened

On March 21, 2026, all 17 individual migrations were consolidated into a single initial migration (`20260321000000_init`) for the first production deployment.

## Why This Was Done

During the first production deployment, migration `20260320000000_vm_by_repo_environment` failed due to attempting to add a column (`environment`) to `vm_approval_requests` that was already added in a previous migration (`20260318163300_vm_approval_workflow`).

Since this was a **fresh production database with no existing data**, it was the perfect opportunity to:
1. Eliminate migration conflicts entirely
2. Simplify the migration history
3. Speed up future deployments
4. Start with a clean slate

## Archived Migrations

The following 17 migrations were archived in this directory:

1. `20260310172500_init` - Initial schema
2. `20260310175446_deployment_audit_tables` - Added audit tables
3. `20260310182532_repository_secrets` - Added repository secrets
4. `20260310190000_deployment_idempotency_key` - Added deployment keys
5. `20260310200000_github_deployment_id` - Added GitHub deployment IDs
6. `20260310213000_deployment_jobs_queue` - Added job queue
7. `20260311093000_deployment_job_timeout` - Added job timeouts
8. `20260311102000_queue_alert_snooze` - Added alert snooze
9. `20260311123000_cleanup_query_indexes` - Optimized indexes
10. `20260311133000_webhook_delivery_idempotency` - Webhook idempotency
11. `20260311143000_webhook_delivery_counters` - Webhook counters
12. `20260311150000_deployment_job_counters` - Job counters
13. `20260311214500_admin_role_bindings` - Admin RBAC
14. `20260315180000_repository_api_token` - Repository API tokens
15. `20260318163300_vm_approval_workflow` - VM approval system
16. `20260320000000_vm_by_repo_environment` - Environment-based VMs (had conflict)
17. `20260321000000_virtualizor_plans_table` - Virtualizor plans

## New Migration

**`20260321000000_init`** - Consolidated initial migration that creates all tables, indexes, and relationships in their final state.

## How to Use

### For Fresh Deployments (Recommended)
Simply run the migration as normal:
```bash
npx prisma migrate deploy
```

### If Reverting is Needed
If for any reason you need to revert to the old migrations:
1. Stop the application
2. Drop the database
3. Move migrations from `migrations_archive/` back to `migrations/`
4. Remove `20260321000000_init` migration
5. Re-run migrations

## Impact

- ✅ All existing functionality preserved
- ✅ All tables, indexes, and relationships identical to what would have been created by all 17 migrations
- ✅ No data loss (database was fresh/empty)
- ✅ Migration conflict resolved
- ✅ Faster deployment times
- ✅ Cleaner migration history

## Verification

After deployment, verify the schema matches expectations:
```sql
SHOW TABLES;
SHOW CREATE TABLE vms;
SHOW CREATE TABLE vm_approval_requests;
```

Both `vms` and `vm_approval_requests` should have the `environment` column and proper unique indexes on `(repositoryId, environment)`.
