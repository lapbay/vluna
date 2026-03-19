Community-only tests

- Cover OSS surface area only; do not import from `@vluna/vluna-enterprise`.
- Tag each suite or test with `@community-only` when edition-specific.
- Uses `tsconfig.vitest.community.json` to enforce the dependency boundary.
