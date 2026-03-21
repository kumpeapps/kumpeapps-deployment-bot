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

-- AddForeignKey
ALTER TABLE `secrets_resolution_audit` ADD CONSTRAINT `secrets_resolution_audit_deploymentId_fkey` FOREIGN KEY (`deploymentId`) REFERENCES `deployments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `caddy_releases` ADD CONSTRAINT `caddy_releases_deploymentId_fkey` FOREIGN KEY (`deploymentId`) REFERENCES `deployments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
