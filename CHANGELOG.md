# Changelog

This project follows [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver): versions are `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at epoch 1 (`100.0.0`). A change to the first number can break your app; minor and patch releases don't.

## Unreleased

The first release.

- Migrations: `defineMigration` files in `convex/migrations/`, run in order by `dev`, `deploy` and the images, with a validated push after they finish.
- Seeding: `defineSeed` table and function seeds in `convex/seeds/`.
- Commands: `init`, `new`, `dev`, `seed`, `deploy`, `status`, `check`, `verify`, `codegen`, `build`, `test-upgrade` and `bundle`.
- Images: combined and one-shot, each with a `-runtime` variant, for amd64 and arm64. Builds install with npm, pnpm, Yarn or Bun.
- Preview settings: `CONVEX_RELEASE_SEED`, `CONVEX_RELEASE_SNAPSHOT` and `CONVEX_RELEASE_ON_DOWNGRADE`.
