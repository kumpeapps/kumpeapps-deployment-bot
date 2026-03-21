CREATE TABLE `queue_alert_snoozes` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `reason` VARCHAR(500) NOT NULL,
  `starts_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `ends_at` DATETIME(3) NOT NULL,
  `actor_type` VARCHAR(50) NOT NULL,
  `actor_id` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `queue_alert_snoozes_ends_at_idx`(`ends_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
