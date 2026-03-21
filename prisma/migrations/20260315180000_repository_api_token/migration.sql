-- AlterTable: Add apiToken field to repositories table
ALTER TABLE `repositories` ADD COLUMN `apiToken` VARCHAR(255) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `repositories_apiToken_key` ON `repositories`(`apiToken`);
