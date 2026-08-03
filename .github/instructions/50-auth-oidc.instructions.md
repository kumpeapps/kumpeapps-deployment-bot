---
generated-by: ai-agent-skills
applyTo: "**/*auth*,**/*oidc*,**/*oauth*,**/security/**"
---

# Auth (OIDC / OAuth)

- Default IdP: **KumpeCloud Auth** (Logto fork). Image: `ghcr.io/kumpecloud/kumpecloud-auth`. APIs and env vars remain Logto-compatible unless documented otherwise.
- Always introduce a provider-agnostic config surface: issuer URL, client id, client secret (confidential clients only), scopes, redirect URIs, audience.
- Support swapping to any standards-compliant OIDC or OAuth 2.x provider without rewriting business logic.
- FastAPI: validate access tokens with JWKS; protect routes via dependencies; never trust unverified claims.
- Angular: authorization code + PKCE; store tokens securely per SPA best practices; refresh via the IdP token endpoint.
- Do not hard-code Logto/KumpeCloud-only SDKs into domain services—keep SDK usage in an auth adapter layer.
