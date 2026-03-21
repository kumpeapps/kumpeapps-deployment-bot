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
