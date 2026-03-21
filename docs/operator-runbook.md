# Operator Runbook

This runbook provides standard incident response procedures for the deployment bot.

## Scope

Primary incident paths covered:

1. Deployment queue backlog and processing degradation.
2. Webhook delivery failures and signature-security issues.
3. Deployment compensation failures and rollback safety.

## Required Access

1. Bot API base URL.
2. Owner or operator admin token.
3. Access to container logs.
4. Access to MariaDB backups/snapshots.

## Baseline Health Commands

1. System health:
   - `curl -fsS http://localhost:3000/health`
2. Prometheus metrics snapshot:
   - `curl -fsS http://localhost:3000/metrics`
3. Queue detail:
   - `curl -fsS -H "x-admin-token: <token>" "http://localhost:3000/api/admin/queue-stats"`
4. Queue alerts/snooze state:
   - `curl -fsS -H "x-admin-token: <token>" "http://localhost:3000/api/admin/queue-alerts?limit=20"`
5. Webhook deliveries:
   - `curl -fsS -H "x-admin-token: <token>" "http://localhost:3000/api/admin/webhook-deliveries?limit=50"`

## Alert Mapping (Threshold to Action)

1. Source: deploymentQueue
   - Signal: `alerts.queueDepthHigh` / `deployment_queue_alert_queue_depth_high_flag`
   - Action:
     - Check `GET /api/admin/queue-stats` for queue depth and estimated clear time.
     - Temporarily raise `DEPLOY_QUEUE_CONCURRENCY` only if host capacity is available.
     - Requeue failed jobs selectively and monitor timeout trends.
2. Source: deploymentQueue
   - Signal: `alerts.timeoutFailuresHigh` / `deployment_queue_alert_timeout_failures_high_flag`
   - Action:
     - Inspect timeout causes in job details.
     - Increase `DEPLOY_QUEUE_JOB_TIMEOUT_MS` only when backed by evidence.
     - Validate SSH and provider latency before broad retries.
3. Source: webhookDeliveries
   - Signal: failed or in-progress spikes (`WEBHOOK_ALERT_*` flags)
   - Action:
     - Review `GET /api/admin/webhook-deliveries` status distribution.
     - Run cleanup operation if stale records dominate.
     - Check GitHub webhook signature and delivery retry health.
4. Source: webhookSecurity
   - Signal: invalid signatures high (`webhook_security_alert_invalid_signatures_1hour_high_flag`)
   - Action:
     - Verify `GITHUB_APP_WEBHOOK_SECRET` correctness.
     - Confirm ingress/proxy does not alter payload bytes.
     - Treat sustained spikes as potential abuse and tighten ingress controls.
5. Source: githubApi
   - Signal: final failures high or circuit open (`github_api_alert_*`)
   - Action:
     - Confirm token validity/scope for deployment APIs.
     - Observe circuit cooldown behavior; avoid hot-loop retries.
     - If persistent, temporarily disable `GITHUB_DEPLOYMENTS_ENABLED`.
6. Source: ssh
   - Signal: final failures or timeout failures high (`ssh_alert_*`)
   - Action:
     - Validate network path, host key policy, and key permissions.
     - Check target VM and Caddy host reachability manually.
     - Adjust SSH timeout/retry parameters only with controlled rollout.
7. Source: virtualizor
   - Signal: API failures or VM ready timeouts high (`virtualizor_alert_*`)
   - Action:
     - Validate provider API status and credentials.
     - Temporarily switch mode to `manual` if provider instability persists.
     - Reduce automated create pressure while stabilizing.
8. Source: secretEncryption
   - Signal: decrypt failures high (`secret_encryption_alert_decrypt_failures_1hour_high_flag`)
   - Action:
     - Verify `SECRET_ENCRYPTION_KEY` and previous keys list.
     - Run rotation operation in dry run first.
     - Halt non-essential secret writes until key consistency is restored.
9. Source: adminApiSecurity
   - Signal: auth failures high (`admin_api_alert_auth_failures_1hour_high_flag`)
   - Action:
     - Validate token distribution and RBAC binding state.
     - Rotate compromised tokens and deactivate old hash bindings.
     - Check for external probing and apply ingress filtering.
10. Source: rateLimit
   - Signal: blocked requests high (`rate_limit_alert_blocked_requests_1hour_high_flag`)
   - Action:
     - Determine if spike is benign burst or abuse.
     - Tune rate limits by endpoint profile only after traffic analysis.
     - Add edge throttling if abuse is sustained.
11. Source: deploymentCompensation
   - Signal: compensation failures high (`deployment_compensation_alert_failures_24h_high_flag`)
   - Action:
     - Inspect recent failed deployments and compensation steps.
     - Validate rollback target integrity (Caddy previous configs, VM compose state).
     - Pause risky deploy triggers until compensation path is healthy.

## Incident Playbook A: Queue Backlog

1. Confirm alert source and severity in `/health` and queue stats endpoint.
2. Identify whether backlog is caused by slow success, repeated failures, or timeouts.
3. If noisy but expected (maintenance), use queue alert snooze with bounded duration.
4. Requeue only deterministic recoverable failures.
5. Escalate if queue depth remains above threshold for two consecutive windows.

## Incident Playbook B: Webhook Failure Spike

1. Check webhook delivery statuses and duplicate/stale counters.
2. Validate webhook secret and payload signature verification path.
3. Trigger cleanup for stale delivery records if needed.
4. Confirm push-event config sync retries are succeeding.
5. Escalate if failed deliveries remain high after retry window and cleanup.

## Incident Playbook C: Compensation Failures

1. Identify failed compensation steps in deployment step logs.
2. Confirm whether Caddy rollback completed or partially failed.
3. Verify VM compose rollback state when enabled.
4. Freeze non-critical deployments and switch to manual dispatch.
5. Escalate immediately for production impact or repeated rollback failure.

## Bad Config Rollout Fail-safe Procedure

1. Stop automated deploy triggers (`AUTO_DEPLOY_ENABLED=false`) if blast radius grows.
2. Re-enable last known-good Caddy config and reload.
3. Requeue only validated safe deployment jobs.
4. Add temporary queue snooze for noise suppression while recovery executes.
5. Record incident summary and remediation actions in audit/log system.

## Escalation Matrix

1. Severity 1 (service down, rollout corruption):
   - Primary: Platform owner on-call.
   - Secondary: Deployment bot maintainer.
   - Escalation target: infrastructure lead.
2. Severity 2 (degraded deployment path, retry storms):
   - Primary: Deployment bot maintainer.
   - Secondary: Platform owner.
3. Severity 3 (isolated failures, low user impact):
   - Primary: Operations engineer.
   - Secondary: Deployment bot maintainer.

## Ownership Contacts

1. Platform owner: TODO
2. Deployment bot maintainer: TODO
3. Infrastructure lead: TODO

## Post-incident Checklist

1. Confirm alert source has returned below threshold.
2. Remove temporary mitigations (snooze, disabled automation) when safe.
3. Record timeline, root cause, and follow-up tasks.
4. Link incident notes in the next release notes under known risks/resolved issues.

## Game-day Simulation Checklist

1. [x] Simulate queue depth breach and verify runbook path execution.
2. [x] Simulate webhook signature failures and verify triage steps.
3. [x] Simulate compensation failure and verify rollback containment.
4. [x] Capture mean-time-to-detect and mean-time-to-recover metrics.

Most recent exercise evidence:

- `docs/operations/game-day-20260311.md`
