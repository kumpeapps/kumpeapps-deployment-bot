CREATE TABLE `github_webhook_deliveries` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `delivery_id` VARCHAR(120) NOT NULL,
  `event_name` VARCHAR(120) NOT NULL,
  `process_status` VARCHAR(20) NOT NULL,
  `error_message` TEXT NULL,
  `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `processed_at` DATETIME(3) NULL,
  `last_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `github_webhook_deliveries_delivery_id_key`(`delivery_id`),
  INDEX `github_webhook_deliveries_process_status_last_attempt_at_idx`(`process_status`, `last_attempt_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
