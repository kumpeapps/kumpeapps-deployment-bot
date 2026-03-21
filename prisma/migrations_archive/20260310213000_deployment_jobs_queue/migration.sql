CREATE TABLE `deployment_jobs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `label` VARCHAR(500) NOT NULL,
  `payload_json` JSON NOT NULL,
  `status` VARCHAR(50) NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `max_attempts` INTEGER NOT NULL DEFAULT 3,
  `error_message` TEXT NULL,
  `deployment_id` INTEGER NULL,
  `started_at` DATETIME(3) NULL,
  `finished_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `deployment_jobs_status_created_at_idx` ON `deployment_jobs`(`status`, `created_at`);
