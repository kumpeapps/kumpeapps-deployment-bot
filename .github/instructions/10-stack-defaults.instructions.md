---
generated-by: ai-agent-skills
applyTo: "**"
---

# Stack defaults

When scaffolding or extending apps unless the user specifies otherwise:

| Layer | Default |
|-------|---------|
| Frontend | Angular (newest stable), standalone + signals |
| Backend | FastAPI + Pydantic v2 |
| ORM | SQLAlchemy 2.x, dialect-agnostic; Alembic migrations |
| Runtime | Docker Compose — separate containers for frontend, backend, database, optional auth |
| Integration tests | MariaDB container (Compose `test` profile) |
| Auth | KumpeCloud Auth OIDC default; provider-agnostic OIDC/OAuth config |

Do not collapse frontend and backend into one container. Prefer Compose profiles `dev` and `test`.
