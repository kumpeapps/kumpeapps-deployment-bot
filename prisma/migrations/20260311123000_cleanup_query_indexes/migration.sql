CREATE INDEX `deployment_jobs_status_finished_at_idx`
ON `deployment_jobs`(`status`, `finished_at`);

CREATE INDEX `queue_alert_snoozes_created_at_idx`
ON `queue_alert_snoozes`(`created_at`);
