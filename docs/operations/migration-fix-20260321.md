# Migration Fix: Migration Consolidation

**Date:** March 21, 2026  
**Status:** Resolved via Consolidation  
**Severity:** Critical - Production deployment blocked  
**Resolution:** Consolidated all 17 migrations into single initial migration

## Issue Summary

Migration `20260320000000_vm_by_repo_environment` failed on fresh database deployments with error:

```
Database error code: 1060
Database error: Duplicate column name 'environment'
Query #8 failed
```

## Root Cause

The migration attempted to add an `environment` column to the `vm_approval_requests` table, but this column was already present from an earlier migration (`20260318163300_vm_approval_workflow`) where the table was initially created.

**Timeline:**
1. Migration `20260318163300_vm_approval_workflow` created `vm_approval_requests` table WITH `environment` column
2. Migration `20260320000000_vm_by_repo_environment` tried to ADD `environment` column again (duplicate)
3. MySQL rejected the duplicate column with error 1060

## Resolution

### Approach Taken: Migration Consolidation

Since this was the **first production deployment with a fresh, empty database**, we consolidated all 17 individual migrations into a single initial migration. This approach:

1. **Eliminates the conflict entirely** - No overlapping changes between migrations
2. **Simplifies debugging** - One migration instead of 17
3. **Cleaner git history** - Fresh start for production
4. **Faster deployments** - Single migration runs much faster
5. **Industry best practice** - Common approach for first production release

### Steps Taken

1. **Archived existing migrations**:
   - Moved all 17 migrations to `prisma/migrations_archive/`
   - Preserved `migration_lock.toml`
   - Created archive README for reference

2. **Created consolidated migration**:
   - New migration: `20260321000000_init`
   - Contains complete schema from `schema.prisma`
   - Includes all tables, indexes, and foreign keys
   - 356 lines of SQL

3. **Documented changes**:
   - Archive README explains what was consolidated
   - Operations doc updated with resolution strategy
   - Verification steps provided

### For Fresh/Clean Databases (Current Production)

1. **Ensure database is clean/empty**:
   ```sql
   DROP DATABASE IF EXISTS Mech_DeploymentBot;
   CREATE DATABASE Mech_DeploymentBot;
   ```

2. **Deploy with consolidated migration**:
   ```bash
   docker-compose down
   docker-compose up -d
   ```

The consolidated migration will create the entire schema in one step.

### Alternative: Quick Fix (Not Used)

The initial approach of fixing the duplicate column in migration `20260320000000_vm_by_repo_environment` would have also worked, but consolidation provides a cleaner long-term solution for first production deployment.

### For Databases with Failed Migration State

If you have a database that's in failed migration state:

1. **Mark the failed migration as rolled back**:
   ```sql
   DELETE FROM _prisma_migrations WHERE migration_name = '20260320000000_vm_by_repo_environment';
   ```

2. **Manually apply the parts that didn't run**:
   Since the migration failed at query 8, queries 1-7 may have succeeded. Check and apply any missing changes:
   
   ```sql
   -- Check if vms.environment exists
   SHOW COLUMNS FROM vms LIKE 'environment';
   
   -- If it doesn't exist, run queries 1-7 from the migration
   -- If it does exist, check indexes:
   SHOW INDEX FROM vms WHERE Key_name = 'vms_repositoryId_environment_key';
   SHOW INDEX FROM vm_approval_requests WHERE Key_name = 'vm_approval_requests_repositoryId_environment_key';
   ```

3. **Re-run the corrected migration**:
   ```bash
   npx prisma migrate deploy
   ```

## Changes Made

**Consolidated Migration:** `/workspaces/kumpeapps-deployment-bot/prisma/migrations/20260321000000_init/migration.sql`

This single migration replaces all 17 previous migrations and creates:
- All 17 database tables with proper schema
- All indexes (primary, unique, and regular indexes)
- All foreign key constraints
- Proper cascade behaviors

**Archived Migrations:** `/workspaces/kumpeapps-deployment-bot/prisma/migrations_archive/`

Contains the original 17 migrations for historical reference:
1. `20260310172500_init` - Initial schema
2. `20260310175446_deployment_audit_tables`
3. `20260310182532_repository_secrets`
4. `20260310190000_deployment_idempotency_key`
5. `20260310200000_github_deployment_id`
6. `20260310213000_deployment_jobs_queue`
7. `20260311093000_deployment_job_timeout`
8. `20260311102000_queue_alert_snooze`
9. `20260311123000_cleanup_query_indexes`
10. `20260311133000_webhook_delivery_idempotency`
11. `20260311143000_webhook_delivery_counters`
12. `20260311150000_deployment_job_counters`
13. `20260311214500_admin_role_bindings`
14. `20260315180000_repository_api_token`
15. `20260318163300_vm_approval_workflow`
16. `20260320000000_vm_by_repo_environment` *(had the conflict)*
17. `20260321000000_virtualizor_plans_table`

## Prevention

This issue occurred because:
1. The `vm_approval_requests` table was added in a later PR/migration
2. The `vm_by_repo_environment` migration was created before that PR was merged
3. The migration wasn't updated to account for the fact that the column already existed

**Going forward:**
- Always rebase feature branches before creating migrations
- Check existing migrations for table definitions before adding columns
- Test migrations on fresh databases before production deployment
- Consider using `IF NOT EXISTS` clauses where appropriate (though Prisma doesn't generate these)

## Verification

After applying the consolidated migration, verify:

```bash
# Check migration status
docker exec bot-1 npx prisma migrate status

# Or check Docker logs
docker logs bot-1 2>&1 | grep -A 5 "migration"
```

Expected output:
```
Running database migrations...
Prisma schema loaded from prisma/schema.prisma
1 migration found in prisma/migrations
Applying migration `20260321000000_init`
The migration has been applied successfully.
```

**Verify database structure:**
```sql
# Connect to MySQL
mysql -h rw.sql.pvt.kumpedns.us -u [user] -p Mech_DeploymentBot

# Check all tables were created
SHOW TABLES;

# Verify vms table
DESCRIBE vms;
SHOW INDEX FROM vms;

# Verify vm_approval_requests table
DESCRIBE vm_approval_requests;
SHOW INDEX FROM vm_approval_requests;
```

Expected results:
- 17 tables created (users, repositories, vms, deployments, etc.)
- `vms.environment` column exists (VARCHAR(50) NOT NULL)
- `vm_approval_requests.environment` column exists (VARCHAR(50) NOT NULL)
- Unique index on `vms(repositoryId, environment)`
- Unique index on `vm_approval_requests(repositoryId, environment)`
- No old indexes on `(repositoryId, vmHostname)`

## Related Issues

- Initial migration: `20260310172500_init`
- VM approval workflow: `20260318163300_vm_approval_workflow`
- Environment-based VMs: `20260320000000_vm_by_repo_environment`
