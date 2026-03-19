# Test layout & tags

- `shared/` - edition‑agnostic tests that should pass for every build.
- `community/` - OSS‑only surface; **must not** import anything under `src/enterprise/**`. Tag with `@community-only`.
- `enterprise/` - enterprise‑only features; can reuse shared/community helpers. Tag with `@enterprise-only`.
- `postgres/` - integration tests against Postgres 17 (RLS, idempotency, pricing math). Run for both editions.
- `utils/` - test helpers (app bootstrap, db containers, fixtures).

Use `vitest -c vitest.config.community.ts` for community runs (excludes enterprise) and `vitest -c vitest.config.enterprise.ts` for enterprise runs. Tag filtering: `--tag community-only`, `--tag enterprise-only`, `--tag db`, `--tag api`, `--tag unit`, `--tag service`.
