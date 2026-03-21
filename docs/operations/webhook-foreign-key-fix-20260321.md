# Bug Fix: Foreign Key Constraint on installation_repositories Webhook

**Date:** March 21, 2026  
**Status:** Resolved  
**Severity:** Critical - Webhook processing failing

## Issue Summary

After deploying the consolidated migration, the bot started receiving `installation_repositories.added` webhooks from GitHub but failed to process them with error:

```
Foreign key constraint violated on the fields: (`installationId`)
Invalid `prisma.repository.upsert()` invocation
```

## Root Cause

When GitHub sends the `installation_repositories.added` event (which happens when repositories are added to an existing GitHub App installation), the webhook handler tried to upsert repositories that reference an `installationId` in the `github_installations` table.

**The Problem:**
- The `upsertInstallationRepositories` function assumed the installation record already existed
- If the installation record didn't exist in the database, the foreign key constraint would fail
- This could happen if:
  - The app missed the `installation.created` webhook
  - The database was cleared/reset after installation
  - The installation was created before the bot was deployed

## Solution

Modified the `upsertInstallationRepositories` function to **ensure the installation record exists** before attempting to upsert repositories:

1. **First:** Upsert the `github_installations` record
   - Creates it if it doesn't exist
   - Updates `accountLogin` if provided and record exists
   - Uses minimal data if creating (can be updated later by full installation webhook)

2. **Then:** Upsert the repositories as normal

## Changes Made

### 1. Updated `upsertInstallationRepositories` Function

**File:** [src/services/installations.ts](src/services/installations.ts)

- Added optional `accountLogin` parameter
- Added installation record upsert at the beginning of the transaction
- Installation is created with minimal data if it doesn't exist
- `accountLogin` is updated if provided and installation exists

### 2. Updated Webhook Handlers

**File:** [src/routes/webhooks.ts](src/routes/webhooks.ts)

- `installation_repositories.added` handler now passes `accountLogin`
- `installation_repositories.removed` handler now passes `accountLogin`
- Both handlers extract account info from `payload.installation.account`

## Impact

✅ **Webhooks now process successfully** - No more foreign key constraint errors  
✅ **Graceful handling** - Works even if installation record is missing  
✅ **Data consistency** - Installation records are automatically created when needed  
✅ **No data loss** - All repository additions/removals are properly tracked  

## Testing

To verify the fix works:

1. **Add a repository to your GitHub App installation:**
   - Go to GitHub App settings
   - Select "Repository access"
   - Add a new repository

2. **Check bot logs:**
   ```bash
   docker logs -f bot-1 | grep "installation_repositories"
   ```

3. **Expected output:**
   ```
   Received GitHub webhook
     deliveryId: "..."
     event: "installation_repositories"
     installationId: ...
   Webhook processed successfully
   ```

4. **Verify database:**
   ```sql
   SELECT * FROM github_installations WHERE installationId = ...;
   SELECT * FROM repositories WHERE installationId = ...;
   ```

## Prevention

This issue was caught in production because:
- Fresh database deployment
- GitHub App had existing installations
- Webhook events arrived before full installation data was synced

**Going forward:**
- The fix ensures webhook handlers are resilient to missing data
- Installation records are created automatically as needed
- Account login information is properly captured from webhook payloads

## Related Issues

- Migration consolidation: [docs/operations/migration-fix-20260321.md](migration-fix-20260321.md)
- This was discovered immediately after the migration consolidation was deployed
