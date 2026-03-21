-- AlterTable: add optional github_deployment_id to deployments for GitHub Deployment API tracking
ALTER TABLE `deployments` ADD COLUMN `github_deployment_id` BIGINT NULL;
