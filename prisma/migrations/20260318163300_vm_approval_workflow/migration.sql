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
    UNIQUE INDEX `vm_approval_requests_repositoryId_vmHostname_key`(`repositoryId`, `vmHostname`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `vm_approval_requests` ADD CONSTRAINT `vm_approval_requests_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vm_approval_requests` ADD CONSTRAINT `vm_approval_requests_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
