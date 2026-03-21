-- CreateEnum
CREATE TABLE IF NOT EXISTS `UserStatus_enum` (
  `value` VARCHAR(50) NOT NULL PRIMARY KEY
) ENGINE=InnoDB;

-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `githubUsername` VARCHAR(255) NOT NULL,
    `status` ENUM('pending', 'approved', 'suspended') NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `users_githubUsername_key`(`githubUsername`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_limits` (
    `userId` INTEGER NOT NULL,
    `maxDomains` INTEGER NOT NULL DEFAULT 0,
    `maxVms` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approved_domains` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `domain` VARCHAR(255) NOT NULL,
    `isWildcard` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `approved_domains_userId_domain_key`(`userId`, `domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_authorized_plans` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `planName` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `user_authorized_plans_userId_planName_key`(`userId`, `planName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plans` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `dev_plan_id` VARCHAR(255) NULL,
    `stage_plan_id` VARCHAR(255) NULL,
    `prod_plan_id` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plans_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `github_installations` (
    `installationId` BIGINT NOT NULL,
    `accountLogin` VARCHAR(255) NOT NULL,
    `permissionsSnapshot` JSON NULL,
    `installedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`installationId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `repositories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `installationId` BIGINT NOT NULL,
    `owner` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `defaultBranch` VARCHAR(255) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `apiToken` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `repositories_owner_name_key`(`owner`, `name`),
    UNIQUE INDEX `repositories_apiToken_key`(`apiToken`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `repository_secrets` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `repositoryId` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `value` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `repository_secrets_repositoryId_name_key`(`repositoryId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `repository_users` (
    `repositoryId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `role` VARCHAR(50) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`repositoryId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vms` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `repositoryId` INTEGER NOT NULL,
    `environment` VARCHAR(50) NOT NULL,
    `vmHostname` VARCHAR(255) NOT NULL,
    `virtualizorVmId` VARCHAR(255) NULL,
    `state` VARCHAR(50) NOT NULL DEFAULT 'pending',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `vms_repositoryId_idx`(`repositoryId`),
    UNIQUE INDEX `vms_repositoryId_environment_key`(`repositoryId`, `environment`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vm_approval_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `repositoryId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `vmHostname` VARCHAR(255) NOT NULL,
    `environment` VARCHAR(50) NOT NULL,
    `githubIssueNumber` INTEGER NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
    `requestedBy` VARCHAR(255) NOT NULL,
    `approvedBy` VARCHAR(255) NULL,
    `approvedAt` DATETIME(3) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `vm_approval_requests_repositoryId_idx`(`repositoryId`),
    INDEX `vm_approval_requests_userId_idx`(`userId`),
    UNIQUE INDEX `vm_approval_requests_repositoryId_environment_key`(`repositoryId`, `environment`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `deployment_configs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `repositoryId` INTEGER NOT NULL,
    `environment` VARCHAR(50) NOT NULL,
    `configPath` VARCHAR(500) NOT NULL,
    `configHash` VARCHAR(64) NOT NULL,
    `parsedJson` JSON NOT NULL,
    `lastSeenCommitSha` VARCHAR(80) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `deployment_configs_repositoryId_environment_configPath_key`(`repositoryId`, `environment`, `configPath`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `deployments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `repositoryId` INTEGER NOT NULL,
    `environment` VARCHAR(50) NOT NULL,
    `deploymentKey` VARCHAR(191) NOT NULL,
    `triggeredBy` VARCHAR(255) NULL,
    `commitSha` VARCHAR(80) NOT NULL,
    `status` VARCHAR(50) NOT NULL,
    `github_deployment_id` BIGINT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    UNIQUE INDEX `deployments_deploymentKey_key`(`deploymentKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `deployment_steps` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deploymentId` INTEGER NOT NULL,
    `stepName` VARCHAR(120) NOT NULL,
    `status` VARCHAR(50) NOT NULL,
    `logExcerpt` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `actorType` VARCHAR(50) NOT NULL,
    `actorId` VARCHAR(255) NOT NULL,
    `action` VARCHAR(120) NOT NULL,
    `resourceType` VARCHAR(120) NOT NULL,
    `resourceId` VARCHAR(255) NOT NULL,
    `payloadJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `secrets_resolution_audit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deploymentId` INTEGER NOT NULL,
    `envKey` VARCHAR(255) NOT NULL,
    `secretName` VARCHAR(255) NOT NULL,
    `resolved` BOOLEAN NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `caddy_releases` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deploymentId` INTEGER NOT NULL,
    `caddyHost` VARCHAR(255) NOT NULL,
    `configChecksum` VARCHAR(64) NOT NULL,
    `reloadStatus` VARCHAR(50) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `deployment_jobs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `label` VARCHAR(500) NOT NULL,
    `payload_json` JSON NOT NULL,
    `status` VARCHAR(50) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 3,
    `timeout_ms` INTEGER NOT NULL DEFAULT 1800000,
    `error_message` TEXT NULL,
    `deployment_id` INTEGER NULL,
    `lease_reclaim_count` INTEGER NOT NULL DEFAULT 0,
    `requeue_count` INTEGER NOT NULL DEFAULT 0,
    `timeout_failures_count` INTEGER NOT NULL DEFAULT 0,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `deployment_jobs_status_created_at_idx`(`status`, `created_at`),
    INDEX `deployment_jobs_status_finished_at_idx`(`status`, `finished_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `queue_alert_snoozes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reason` VARCHAR(500) NOT NULL,
    `starts_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ends_at` DATETIME(3) NOT NULL,
    `actor_type` VARCHAR(50) NOT NULL,
    `actor_id` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `queue_alert_snoozes_ends_at_idx`(`ends_at`),
    INDEX `queue_alert_snoozes_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `github_webhook_deliveries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `delivery_id` VARCHAR(120) NOT NULL,
    `event_name` VARCHAR(120) NOT NULL,
    `process_status` VARCHAR(20) NOT NULL,
    `attempts_count` INTEGER NOT NULL DEFAULT 1,
    `duplicate_count` INTEGER NOT NULL DEFAULT 0,
    `stale_reclaims` INTEGER NOT NULL DEFAULT 0,
    `error_message` TEXT NULL,
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) NULL,
    `last_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `github_webhook_deliveries_delivery_id_key`(`delivery_id`),
    INDEX `github_webhook_deliveries_process_status_last_attempt_at_idx`(`process_status`, `last_attempt_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_role_bindings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token_hash` VARCHAR(128) NOT NULL,
    `role` VARCHAR(50) NOT NULL,
    `description` VARCHAR(500) NULL,
    `source` VARCHAR(50) NOT NULL DEFAULT 'manual',
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admin_role_bindings_token_hash_key`(`token_hash`),
    INDEX `admin_role_bindings_active_role_idx`(`active`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_limits` ADD CONSTRAINT `user_limits_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approved_domains` ADD CONSTRAINT `approved_domains_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_authorized_plans` ADD CONSTRAINT `user_authorized_plans_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repositories` ADD CONSTRAINT `repositories_installationId_fkey` FOREIGN KEY (`installationId`) REFERENCES `github_installations`(`installationId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repository_secrets` ADD CONSTRAINT `repository_secrets_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repository_users` ADD CONSTRAINT `repository_users_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repository_users` ADD CONSTRAINT `repository_users_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vms` ADD CONSTRAINT `vms_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vms` ADD CONSTRAINT `vms_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vm_approval_requests` ADD CONSTRAINT `vm_approval_requests_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vm_approval_requests` ADD CONSTRAINT `vm_approval_requests_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deployment_configs` ADD CONSTRAINT `deployment_configs_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deployments` ADD CONSTRAINT `deployments_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deployment_steps` ADD CONSTRAINT `deployment_steps_deploymentId_fkey` FOREIGN KEY (`deploymentId`) REFERENCES `deployments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `secrets_resolution_audit` ADD CONSTRAINT `secrets_resolution_audit_deploymentId_fkey` FOREIGN KEY (`deploymentId`) REFERENCES `deployments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `caddy_releases` ADD CONSTRAINT `caddy_releases_deploymentId_fkey` FOREIGN KEY (`deploymentId`) REFERENCES `deployments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
