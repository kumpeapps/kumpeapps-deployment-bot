---
generated-by: ai-agent-skills
applyTo: "**/*.{ts,html,scss,css}"
---

# Angular

- Prefer newest stable Angular; use standalone components and signals by default.
- Lazy-load feature routes; keep smart/container vs presentational boundaries clear.
- Use Angular's HTTP client with interceptors for Bearer tokens.
- Auth: authorization code + PKCE against OIDC (KumpeCloud Auth default); never embed client secrets in the SPA.
- Tests: TestBed / Jest or Vitest as configured; write failing tests before component/service changes.
- Match existing project style (ESLint, Prettier) when present; otherwise use current Angular CLI defaults.
