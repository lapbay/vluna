# Contributing to Vluna OSS

Thanks for helping improve Vluna OSS. Please read this before opening PRs.

## Development workspace

Run all commands from the `vluna/oss` directory.

## Requirements

- Node.js 22+
- pnpm 9+
- PostgreSQL 16+ (for local setup)

## Setup

```bash
cd vluna/oss
pnpm install
```

## Common commands

- `pnpm community:setup`: prepare local DB/schema and seed required data.
- `pnpm community:dev`: start app in dev mode.
- `pnpm community:lint`: lint core and app packages.
- `pnpm community:typecheck`: run workspace type checks.
- `pnpm core:test:community`: run community test suite.

## Contribution workflow

- Keep PRs focused and small.
- Link related issues when possible.
- Include clear verification steps in the PR description.
- Run formatter/lint/tests relevant to touched code before submitting.

## Community support and etiquette

- Use clear, reproducible reproduction steps when reporting defects.
- Keep runtime/DB credentials out of PRs and discussions.

## License and attribution

By submitting a PR you agree your contribution is provided under the same project license.
