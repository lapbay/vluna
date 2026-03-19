# vluna/src Directory Map

Use this as a quick index to locate code by responsibility. Only covers `apps/vluna/src`.

- `main.ts`: Application entry point; registers globals and starts the server.
- `modules/`: NestJS module wiring (e.g., `app.module.ts`, health, OIDC).
- `features/`: HTTP endpoints grouped by domain.
  - `billing/`: `billing.feature.module.ts` and controllers for Catalog, Checkout, Portal, Invoices, Subscriptions, Payments, Usage, Wallet, Ops.
  - `oidc/`: Controllers for sign‑in/profile/webhooks.
  - `admin/`: Admin/IAM convenience endpoints.
  - `system/`: Non‑domain controllers (health, sample, consent).
- `auth/`: AuthZ/AuthN helpers.
  - `guards/*`: Realm/auth/scopes/org/principal guards.
  - `decorators/*`: Route decorators for scopes/realm/audience.
  - `tokens/*`: Token validators and types.
  - `constants/*`: Scope constants.
- `repositories/`: Shared database query functions (Kysely). No HTTP logic. Reuse `types/database.ts` shapes (no ad‑hoc row types).
- `db/`: Database bootstrap (pg pool, Kysely, migrations, RLS helpers).
- `contracts/`: Generated OpenAPI types and helpers (do not edit manually).
- `auth/`: AuthZ/AuthN helpers.
  - `oidc/`: OIDC adapters, JWT verification, management API clients (re‑exports of `security/oidc/*`; prefer importing from here).
- `support/`: Interceptors, middleware, filters, tracing utilities.
- `common/`: Shared response envelope and error helpers.
- `types/`: Project‑wide type definitions.
  - `database.ts`: Canonical table shapes for Kysely.
  - `request-context.ts`: Request context (`realmId`, `billingAccountId`, `db`, etc.).
  - (optional) ambient typings when needed for tooling quirks; avoid unless necessary.
  - `http.ts`, `user.types.ts`, `fastify-augment.d.ts`: Misc type helpers.
- `utils/`: Small utilities (e.g., cache).
