Postgres integration tests

- Uses Postgres 17 (testcontainer image `postgres:17-alpine` by default).
- Run with `vitest -c ../../vitest.config.community.ts --tag db` or `pnpm run test:db`.
- Honors `TEST_DB_URL` to reuse an existing database; still enforces `server_version_num >= 170000`.
- Add suites here for RLS, idempotency, pricing math persistence, grant ordering, etc.
