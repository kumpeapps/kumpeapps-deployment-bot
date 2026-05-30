-- Add columns to support the pending_workflows job status.
-- workflow_check_started_at: timestamp of the first workflow check attempt (used for overall timeout).
-- next_workflow_check_at:    earliest time the queue should re-check this job's workflows.

ALTER TABLE `deployment_jobs`
  ADD COLUMN `workflow_check_started_at` DATETIME(3) NULL,
  ADD COLUMN `next_workflow_check_at`    DATETIME(3) NULL;

CREATE INDEX `deployment_jobs_pending_workflows_idx`
  ON `deployment_jobs` (`status`, `next_workflow_check_at`);
