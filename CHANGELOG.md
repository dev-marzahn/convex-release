# Changelog

This project follows [Semantic Versioning](https://semver.org). Before 1.0, a minor version can break things.

## Unreleased

The first release.

- Migrations: `defineMigration` files in `convex/migrations/`, run in order by `dev`, `deploy` and the images, with a validated push after they finish.
- Seeding: `defineSeed` table and function seeds in `convex/seeds/`.
- Commands: `init`, `new`, `dev`, `seed`, `deploy`, `status`, `check`, `verify`, `codegen`, `build`, `test-upgrade` and `bundle`.
- Images: combined and one-shot, each with a `-runtime` variant, for amd64 and arm64. Builds install with npm, pnpm, Yarn or Bun.
- Preview settings: `CONVEX_RELEASE_SEED`, `CONVEX_RELEASE_SNAPSHOT` and `CONVEX_RELEASE_ON_DOWNGRADE`.
