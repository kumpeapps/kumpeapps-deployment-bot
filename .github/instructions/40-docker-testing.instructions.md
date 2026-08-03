---
generated-by: ai-agent-skills
applyTo: "**/docker-compose*.{yml,yaml},**/Dockerfile*,**/.devcontainer/**"
---

# Docker and testing

- Separate containers: at least `frontend`, `backend`, and database services. Optional `auth` (KumpeCloud Auth image).
- Use Compose profiles: `dev` for local development, `test` for MariaDB-backed integration tests.
- Healthchecks and explicit networks; no secrets in images—use env files or secrets mounts.
- Prefer official or current base images at newest stable tags; pin digests in production when possible.
- Integration tests must use MariaDB in Docker, not sqlite, unless the user explicitly requests otherwise.
- Prefer Dev Containers that compose these services rather than running stacks on the host.
