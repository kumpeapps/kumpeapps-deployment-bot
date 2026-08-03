---
generated-by: ai-agent-skills
applyTo: "**"
---

# Coding standards

- **TDD**: Write a failing test first. No production code without a justifying failing test. Red → green → refactor.
- **DRY**: Extract shared logic only when duplication is real; avoid speculative abstractions.
- **SOLID**: Single responsibility, small interfaces, depend on abstractions, open for extension.
- **Python style**: Format with black; lint with ruff (PEP8-aligned); type-hint public APIs.
- **Versions**: Prefer newest stable frameworks/plugins; pin in lockfiles.
- **Environment**: Prefer Dev Container; otherwise Python venv. Never use system Python for project work.
- Reject implementations that skip tests, ignore formatting, or hard-code a single auth vendor without an OIDC/OAuth abstraction.
