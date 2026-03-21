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
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `repositories_owner_name_key`(`owner`, `name`),
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
    `vmHostname` VARCHAR(255) NOT NULL,
    `virtualizorVmId` VARCHAR(255) NULL,
    `state` VARCHAR(50) NOT NULL DEFAULT 'pending',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `vms_repositoryId_vmHostname_key`(`repositoryId`, `vmHostname`),
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
    `triggeredBy` VARCHAR(255) NULL,
    `commitSha` VARCHAR(80) NOT NULL,
    `status` VARCHAR(50) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

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

-- AddForeignKey
ALTER TABLE `user_limits` ADD CONSTRAINT `user_limits_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approved_domains` ADD CONSTRAINT `approved_domains_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repositories` ADD CONSTRAINT `repositories_installationId_fkey` FOREIGN KEY (`installationId`) REFERENCES `github_installations`(`installationId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repository_users` ADD CONSTRAINT `repository_users_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repository_users` ADD CONSTRAINT `repository_users_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vms` ADD CONSTRAINT `vms_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vms` ADD CONSTRAINT `vms_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deployment_configs` ADD CONSTRAINT `deployment_configs_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deployments` ADD CONSTRAINT `deployments_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deployment_steps` ADD CONSTRAINT `deployment_steps_deploymentId_fkey` FOREIGN KEY (`deploymentId`) REFERENCES `deployments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
