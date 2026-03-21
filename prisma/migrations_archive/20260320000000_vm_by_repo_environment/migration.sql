-- AlterTable: Add environment field to vms table
ALTER TABLE `vms` ADD COLUMN `environment` VARCHAR(50) NULL;

-- Backfill environment from metadata for existing VMs
UPDATE `vms` SET `environment` = JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.environment')) WHERE `metadata` IS NOT NULL AND JSON_EXTRACT(`metadata`, '$.environment') IS NOT NULL;

-- Set default environment for any remaining VMs
UPDATE `vms` SET `environment` = 'dev' WHERE `environment` IS NULL;

-- Make environment field required
ALTER TABLE `vms` MODIFY `environment` VARCHAR(50) NOT NULL;

-- Create separate index on repositoryId for the FK constraint to use
ALTER TABLE `vms` ADD INDEX `vms_repositoryId_idx` (`repositoryId`);

-- Drop old unique constraint on repositoryId + vmHostname
ALTER TABLE `vms` DROP INDEX `vms_repositoryId_vmHostname_key`;

-- Add new unique constraint on repositoryId + environment
ALTER TABLE `vms` ADD UNIQUE INDEX `vms_repositoryId_environment_key` (`repositoryId`, `environment`);

-- Update vm_approval_requests table indexes
-- Note: environment column already exists from migration 20260318163300_vm_approval_workflow
-- Drop old unique constraint and add new one
ALTER TABLE `vm_approval_requests` DROP INDEX `vm_approval_requests_repositoryId_vmHostname_key`;
ALTER TABLE `vm_approval_requests` ADD UNIQUE INDEX `vm_approval_requests_repositoryId_environment_key` (`repositoryId`, `environment`);
