ALTER TABLE `deployment_jobs` ADD COLUMN `lease_reclaim_count` INT NOT NULL DEFAULT 0;
ALTER TABLE `deployment_jobs` ADD COLUMN `requeue_count` INT NOT NULL DEFAULT 0;
ALTER TABLE `deployment_jobs` ADD COLUMN `timeout_failures_count` INT NOT NULL DEFAULT 0;
