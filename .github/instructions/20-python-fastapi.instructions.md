---
generated-by: ai-agent-skills
applyTo: "**/*.py"
---

# Python / FastAPI

- Use FastAPI with Pydantic v2 models; prefer async endpoints when I/O-bound.
- Structure: `app/main.py`, `api/routers/`, `core/` (config, security), `models/`, `schemas/`, `services/`, `db/`.
- Inject dependencies via `Depends`; keep routers thin; put business logic in services.
- SQLAlchemy 2.0 style sessions; no raw vendor-specific SQL unless dialect-gated.
- Format with black; lint with ruff; require type hints on public functions.
- TDD with pytest; API tests via `httpx.AsyncClient` / TestClient; integration tests against MariaDB in Docker.
- Auth: JWT validation via JWKS behind a provider-agnostic settings interface (KumpeCloud Auth default).
