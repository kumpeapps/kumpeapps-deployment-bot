ALTER TABLE `github_webhook_deliveries`
  ADD COLUMN `attempts_count` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `duplicate_count` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `stale_reclaims` INTEGER NOT NULL DEFAULT 0;
