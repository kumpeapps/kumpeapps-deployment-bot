-- AlterTable
ALTER TABLE `deployments`
ADD COLUMN `deploymentKey` VARCHAR(191) NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX `deployments_deploymentKey_key` ON `deployments`(`deploymentKey`);
