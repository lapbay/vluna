vluna — NestJS + Fastify service

Overview
- Follows docs/billing/SYSTEM_DECISIONS.md: NestJS + Fastify as the primary runtime and API framework.
- Provides a thin HTTP layer (controllers/guards/interceptors) to align with envelope, idempotency and RLS session context requirements.

Quick start
```bash
pnpm i
pnpm --filter @app/vluna dev
# open http://localhost:3001/health
```

OpenAPI consistency
Use the lint/validate commands at the workspace root to keep the spec healthy:
```bash
pnpm openapi:lint:billing
pnpm openapi:validate:billing
```

Types-only from OpenAPI (for implementation)
```bash
# Generate types for vluna (billing + business project/IAM)
pnpm openapi:gen:vluna

# Outputs
# - apps/vluna/src/contracts/billing.ts
# - apps/vluna/src/contracts/iam.ts
```

Use helpers to extract inputs/outputs by operationId:
```ts
import type { operations as BillingOps } from './src/contracts/billing'
import { JsonRequestBody, JsonResponse, QueryParams, HeaderParams } from './src/contracts/openapi-helpers'

type ListProductsQuery = QueryParams<BillingOps, 'listCatalogProducts'>
type ListProductsResp  = JsonResponse<BillingOps, 'listCatalogProducts', 200>

// In a controller method, you can assert your return type
// function listProducts(...): Envelope & ListProductsResp { ... }
```

Background sweepers
- Periodic tasks are registered in `SchedulerModule`, but **disabled by default** unless selected via process args.
- Use process args:
  - `--tasks-include a,b,c` (run only these tasks)
  - `--tasks-exclude x,y` (run all tasks except these)
  - If neither flag is provided, the process runs **no** periodic tasks.

Project layout
- src/main.ts: bootstrap with Fastify adapter and global prefix /api
- src/modules/app.module.ts: root module
- src/presentation/health.controller.ts: basic readiness endpoint

Next steps (from SYSTEM_DECISIONS)
- Add global interceptors/guards for envelope, X-Realm-Id, Idempotency-Key
- Add persistence layer (Kysely + node-postgres) and RLS session context
- Add webhook endpoints and background workers (BullMQ)
