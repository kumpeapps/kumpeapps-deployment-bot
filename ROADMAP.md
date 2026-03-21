# KumpeApps Deployment Bot Roadmap

This roadmap is the working execution plan for building a GitHub-driven deployment system with a MariaDB-backed control plane.

## Execution Status (Updated 2026-03-11)

### Completed

1. Phase 0: Foundations
   - [x] Service structure, Dockerfile, and local compose setup
   - [x] MariaDB + Prisma migration pipeline
   - [x] GitHub App webhook auth and signature verification
   - [x] Health checks and structured logging
2. Phase 1: Identity and Governance
   - [x] Registration endpoint by GitHub username
   - [x] Admin provisioning workflow
   - [x] User limits and approved domain management
   - [x] Repo installation and ownership linking
3. Phase 2: Config Engine
   - [x] Parse repository config folders and YAML files
   - [x] Schema + semantic validation
   - [x] deploy_rules evaluation for dev/stage/prod
   - [x] Normalized config snapshots persisted with commit SHA
4. Phase 3: Deployment Execution (MVP path)
   - [x] Virtualizor verify/create VM integration
   - [x] SSH deployment to VM (compose + env + up/restart)
   - [x] SSH deployment to Caddy host (config push + reload)
   - [x] Deployment step tracking and queue-based retries
5. Phase 4: Production Hardening (majority)
   - [x] Queue-backed execution and concurrency controls
   - [x] Idempotent deployment keys to prevent duplicate processing
   - [x] Alerting, metrics, and cross-subsystem traceability
   - [x] Suspension/reactivation flows in admin APIs
6. Immediate next steps previously listed in this document
   - [x] Define migration 001 for users/limits/domains/repos/installations
   - [x] Scaffold bot service container with webhook endpoint + DB connectivity
   - [x] Implement registration and admin approval endpoints (v1)

### Remaining

1. Phase 4 hardening follow-ups
   - [x] Rollback/compensation completion for partial deployment failures
   - [x] RBAC completion work (route-level allow/deny integration tests)
2. Open design decisions
   - [x] Repo config detail: inline docker compose YAML vs path reference as primary mode
   - [x] Trigger policy finalization: push/manual/PR/hybrid default model
   - [x] Secret strategy finalization: GitHub-only resolution vs mirrored secret store
   - [x] Execution topology decision: single process vs split web and worker containers
   - [x] Admin interface direction: API-only vs CLI vs web panel

### Next Active Phase (Phase 5: Completion and Policy)

1. Rollback and compensation implementation
   - [x] Add deployment compensation state model (planned, attempted, succeeded, failed)
   - [x] Implement Caddy rollback to last known-good config on post-apply validation failure
   - [x] Add VM deploy compensation mode (best-effort compose down / previous release restore toggle)
   - [x] Persist compensation attempts/results in deployment steps + audit events
   - [x] Add health/metrics counters for compensation attempts and failures
2. RBAC refinement implementation
   - [x] Introduce role model for admin APIs (owner, operator, auditor)
   - [x] Replace global admin token checks with scoped permissions per route group
   - [x] Add migration(s) and seed path for initial role bindings
   - [x] Add audit logging for authorization denials and policy changes
   - [x] Add tests for allow/deny matrix by route and role
3. Architecture and policy decisions
   - [x] Finalize canonical deploy trigger model and document default behavior
   - [x] Finalize secret source strategy and failure-handling policy
   - [x] Finalize runtime topology recommendation (single process vs split web/worker)
   - [x] Finalize admin interface priority and success criteria

Phase 5 exit criteria:

1. A failed deployment can execute deterministic, auditable compensation steps.
2. Admin API access is role-scoped with explicit least-privilege boundaries.
3. All open architecture decisions have recorded outcomes in this roadmap.

## 1) Product Goals

1. Provide a GitHub App bot that automates deployment from repository configuration.
2. Persist all critical deployment state and policy in MariaDB.
3. Enforce admin provisioning, user quotas, and domain safety constraints.
4. Support environment-aware deployment (dev, stage, prod) using repository-side YAML configs.
5. Orchestrate VM creation/verification (Virtualizor), Docker Compose deployment (SSH), and Caddy config rollout (separate SSH).

## 2) Scope (Current)

### In scope

1. GitHub App installation workflow.
2. User registration by GitHub username plus admin approval/provisioning.
3. Limits per user:
   - Max domains/subdomains.
   - Max VMs.
4. Deployment config format under:
   - .kumpeapps-deploy-bot/dev/*.yml
   - .kumpeapps-deploy-bot/stage/*.yml
   - .kumpeapps-deploy-bot/prod/*.yml
5. Only deployment_type: docker.
6. Persist config-derived and runtime state in MariaDB.
7. Validate domain usage against approved domains + config domains.
8. Deployment execution path:
   - Verify or create VM in Virtualizor.
   - Deploy compose and .env to VM through SSH.
   - Deploy Caddy config to Caddy server through separate SSH.
   - Start/restart Docker services.
   - Reload Caddy.

### Out of scope (for now)

1. Kubernetes deployment type.
2. Multi-cloud VM providers beyond Virtualizor.
3. Self-service quota changes (admin-only for now).

## 3) High-Level Architecture

1. GitHub App Bot Service (Docker container)
   - Receives webhooks.
   - Parses and validates deployment configs.
   - Executes deployment pipeline.
   - Posts status/check results back to GitHub.
2. MariaDB
   - Source of truth for users, quotas, domains, repos, VMs, deployments, and audit events.
3. Worker/Queue subsystem (recommended)
   - Decouples webhook ingestion from long-running deployment tasks.
4. Virtualizor API client
   - VM lookup/create/update.
5. SSH Deployer
   - VM deploy channel for compose and .env.
   - Caddy server channel for Caddy config and reload.

## 4) Suggested Implementation Stack

1. Language/runtime: Node.js + TypeScript.
2. GitHub App SDK: Probot or Octokit app auth stack.
3. API/server: Fastify or Express.
4. ORM/query: Prisma or Kysely + migration tool.
5. Queue: BullMQ + Redis (recommended) or database-backed jobs if minimizing infra.
6. YAML parsing/validation: yaml + Zod/JSON schema validation.
7. SSH: ssh2.
8. Containerization: Single bot image with separate worker process mode.

## 5) Config Contract (v1)

Location per repo:

- .kumpeapps-deploy-bot/dev/<name>.yml
- .kumpeapps-deploy-bot/stage/<name>.yml
- .kumpeapps-deploy-bot/prod/<name>.yml

Required top-level keys:

1. deployment_type: must be docker.
2. assigned_username: GitHub username owning this deployment request.
3. vm_hostname: target VM hostname identifier.
4. domains: list of domains/subdomains to route.
5. docker_compose: compose content or path reference.
6. caddy:
   - one or more Caddy site blocks/templates.
7. env_mappings:
   - map env var name to repository secret key.
8. deploy_rules:
   - branch/tag/path rules to determine dev/stage/prod deployment trigger.

Validation rules:

1. assigned_username must exist and be admin-approved.
2. deployment_type must equal docker.
3. domains in caddy config must be subset of:
   - user approved domains, and
   - domains listed in deployment config.
4. vm request must not exceed user VM quota.
5. domain count must not exceed domain/subdomain quota.

## 6) Data Model Roadmap (MariaDB)

Core tables (initial):

1. users
   - id, github_username (unique), status (pending/approved/suspended), created_at.
2. user_limits
   - user_id, max_domains, max_vms.
3. approved_domains
   - id, user_id, domain, is_wildcard, created_at.
4. github_installations
   - installation_id, account, installed_at, permissions_snapshot.
5. repositories
   - id, installation_id, owner, name, default_branch, active.
6. repository_users
   - repository_id, user_id, role.
7. vms
   - id, user_id, repository_id, vm_hostname, virtualizor_vm_id, state, metadata.
8. deployment_configs
   - id, repository_id, environment, config_path, config_hash, parsed_json, last_seen_commit_sha.
9. deployments
   - id, repository_id, environment, triggered_by, commit_sha, status, started_at, finished_at.
10. deployment_steps
   - deployment_id, step_name, status, log_excerpt, started_at, finished_at.
11. secrets_resolution_audit
   - deployment_id, env_key, secret_name, resolved (boolean).
12. caddy_releases
   - deployment_id, caddy_host, config_checksum, reload_status.
13. audit_events
   - actor_type, actor_id, action, resource_type, resource_id, payload_json, created_at.

## 7) Deployment Flow (v1)

1. Webhook received (push/pr/dispatch).
2. Determine candidate environment from deploy_rules.
3. Load YAML config(s) from environment folder.
4. Validate schema and policy constraints.
5. Resolve repo secrets for env_mappings.
6. Verify/create VM in Virtualizor.
7. SSH to VM:
   - prepare deploy directory,
   - upload compose,
   - generate .env,
   - docker compose pull/up.
8. SSH to Caddy server:
   - upload Caddy config,
   - run caddy validate (if available),
   - reload Caddy.
9. Persist all outcomes in deployments and step logs.
10. Report status back to GitHub check/run/comment.

## 8) Security and Compliance Controls

1. Least privilege GitHub App permissions.
2. Secrets never persisted in plaintext DB logs.
3. Encrypt sensitive config at rest where needed.
4. Strict domain validation parser to prevent rogue Caddy host rules.
5. Command execution hardening for SSH operations.
6. Full audit trail for admin provisioning and deployment actions.
7. Idempotent deployment keys to prevent duplicate processing on retries.

## 9) Delivery Phases

### Phase 0: Foundations

1. Initialize service structure, Dockerfile, compose for local dev.
2. Add MariaDB + migration pipeline.
3. Add GitHub App auth and webhook verification.
4. Add health checks and structured logging.

Exit criteria:

1. Webhook received and verified.
2. DB migrations run cleanly.
3. Bot runs in Docker locally.

### Phase 1: Identity and Governance

1. Registration endpoint/command by GitHub username.
2. Admin provisioning workflow.
3. User limits and approved domain management.
4. Repo installation and ownership linking.

Exit criteria:

1. Pending users can be approved by admin.
2. Limits and domain policies enforced by API checks.

### Phase 2: Config Engine

1. Parse repo config folders and YAML files.
2. Build schema + semantic validation.
3. Implement deploy_rules evaluation for dev/stage/prod.
4. Store normalized config snapshots in DB.

Exit criteria:

1. Invalid config returns actionable errors.
2. Valid config snapshots persist with commit SHA.

### Phase 3: Deployment Execution

1. Virtualizor verify/create VM integration.
2. SSH deployment to VM (compose + env + up/restart).
3. SSH deployment to Caddy host (config + reload).
4. Deployment step tracking and retries.

Exit criteria:

1. End-to-end deployment works for dev env.
2. Caddy reload occurs only after validation passes.

### Phase 4: Production Hardening

1. Queue-backed workers and concurrency controls.
2. Idempotency and rollback/compensation strategy.
3. Alerting, metrics, and traceability.
4. RBAC refinement and suspension flows.

Exit criteria:

1. Parallel deployments are safe.
2. Failed deployments have clear diagnostics.

## 10) Open Design Decisions

All major architecture decisions for v1 are now resolved and recorded below.

1. Repo config format detail
   - Decision: support both inline docker compose YAML and path reference, with inline as canonical default for v1.
   - Rationale: inline keeps each deployment definition self-contained and simplifies validation/diffing; path reference remains available for larger compose artifacts.
2. Deploy trigger model
   - Decision: hybrid model (manual dispatch via admin API plus push-triggered auto deploy when enabled).
   - Rationale: manual execution is the safe default for controlled rollout; push automation is optional and environment-gated for teams ready for continuous delivery.
3. Secret resolution strategy
   - Decision: mirrored encrypted control-plane store as primary source (repository_secrets), with unresolved-secret fail-fast for non-dry-run deploys.
   - Rationale: avoids runtime dependence on external secret API availability and provides auditable, deterministic secret resolution behavior.
4. Job execution model
   - Decision: single-process web+worker remains default for v1 deployment simplicity; split web/worker containers is the production scale recommendation.
   - Rationale: current workload and operational footprint favor simpler deployment, while queue design already supports future horizontal split.
5. Admin interface
   - Decision: API-first for v1, CLI/web panel deferred.
   - Success criteria:
     - All governance and deployment controls are scriptable via authenticated APIs.
     - RBAC scopes cover owner/operator/auditor operational needs.
     - Audit trail records all privileged actions and authorization denials.

## 11) Immediate Next Steps

1. Package and release candidate
   - [x] Create release candidate tag and immutable image tag
   - [x] Run migration dry run against staging-like database snapshot
   - [x] Run smoke suite: health, webhook receive, config sync, manual deploy enqueue, queue stats
   - [x] Add repeatable smoke-test command and release checklist documentation
   - [x] Add release notes scaffold generator and template
   - [x] Publish release notes with env var delta and migration notes
   - Acceptance criteria:
     - Release artifact is reproducible from a tagged commit.
     - Smoke suite passes with no Sev-1/Sev-2 issues.
2. Prepare operator runbook
   - [x] Define standard operating procedures for queue backlog, webhook failure spikes, and compensation failures
   - [x] Add alert response playbooks with threshold-to-action mapping
   - [x] Add rollback and fail-safe procedures for bad config rollouts
   - [x] Include escalation matrix and ownership contacts
   - Acceptance criteria:
     - On-call engineer can execute top 3 incident paths without code changes.
     - All major alert sources in `/health` and `/metrics` map to a documented runbook action.
3. Contribution and iteration hygiene
   - [x] Add issue templates for bug, hardening task, and design decision records
   - [x] Add PR template requiring test evidence and migration impact notes
   - [x] Add contribution guide section for release process and rollback safety checks
   - Acceptance criteria:
     - New PRs include required operational impact fields by default.
     - Backlog items are classifiable into implementation, hardening, or decision categories.

## 13) Post-v1 Execution Board

1. Track A: Release Readiness
   - Objective: ship stable v1 candidate and validate operability.
   - Target window: next 1-2 sprints.
   - Exit condition: release candidate deployed with passing smoke suite and signed release notes.
2. Track B: Operations Maturity
   - Objective: reduce incident response time and ambiguity.
   - Target window: parallel with Track A.
   - Exit condition: runbook complete, reviewed, and exercised in one game-day simulation.
   - Status evidence:
     - [x] Runbook complete: `docs/operator-runbook.md`
     - [x] Runbook reviewed for incident use
     - [x] One game-day simulation executed: `docs/operations/game-day-20260311.md`
3. Track C: Team Workflow Quality
   - Objective: standardize incoming work and review quality.
   - Target window: same sprint as release candidate publication.
   - Exit condition: templates and contribution rules active in default branch.

## 12) Definition of Done (MVP)

1. Approved user with limits can deploy a docker app from repo config.
2. VM is verified/created and recorded in DB.
3. Compose app is deployed over SSH with generated .env from mapped secrets.
4. Caddy config is deployed only for approved domains and reloaded successfully.
5. GitHub receives deployment status and DB has complete audit records.
