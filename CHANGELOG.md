# Changelog

This project follows [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver): versions are `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at epoch 1 (`100.0.0`). A change to the first number can break your app; minor and patch releases don't.

## Unreleased

- Hooks: `CONVEX_RELEASE_PRE_PUSH` and `CONVEX_RELEASE_POST_APPLY` name commands for both images to run, before the first push and before the container reports ready. Each gets the deployment's `CONVEX_URL` and `CONVEX_ADMIN_KEY`. A hook that exits with a non-zero code fails the start, like a failed migration.
- Backups: with `CONVEX_RELEASE_BACKUP_DIR` set, both images export the deployment before they migrate it, and keep the newest `CONVEX_RELEASE_BACKUP_KEEP` (default 3). Every attempt at one upgrade reuses the same backup, including a fix release shipped while the upgrade fails, so a restart loop can't rotate out the backup from before the upgrade. A failed backup stops the start before anything is pushed. Restore a backup through `CONVEX_RELEASE_SNAPSHOT`.
- The images record the app's `package.json` version in the deployment variable `CONVEX_RELEASE_VERSION`. `bundle` writes it into `release.json`.
- An invalid setting stops a container before it changes anything.

## 100.1.0 (2026-11-15)

- Predeploy checks: a dependency can declare `convex-release.predeploy` in its `package.json`. `deploy`, both images and the first push of `dev` run that check before anything is pushed, and a failed check refuses the release. `check` reports the checks. `--skip-check` and `CONVEX_RELEASE_SKIP_CHECKS` skip a named check. Library authors can import the check types from `@dev-marzahn/convex-release`.
- Releases with a prerelease version publish to npm's `next` dist-tag and don't move the images' `latest` and `runtime` tags.

## 100.1.0-next.0 (2026-11-15)

A prerelease of 100.1.0 on npm's `next` dist-tag, for libraries to try the predeploy check contract.

## 100.0.1 (2026-11-14)

- convex-release is now licensed under MPL-2.0. 100.0.0 and earlier stay under MIT.
- The package declares the Node version it needs: 22.18.0 or later.
- The README's first deploy command uses the scoped package name, `npx @dev-marzahn/convex-release deploy`.
- Releases are published with npm provenance.

## 100.0.0 (2026-11-14)

The first release.

- Migrations: `defineMigration` files in `convex/migrations/`, run in order by `dev`, `deploy` and the images, with a validated push after they finish.
- Seeding: `defineSeed` table and function seeds in `convex/seeds/`.
- Commands: `init`, `new`, `dev`, `seed`, `deploy`, `status`, `check`, `verify`, `codegen`, `build`, `test-upgrade` and `bundle`.
- Images: combined and one-shot, each with a `-runtime` variant, for amd64 and arm64. Builds install with npm, pnpm, Yarn or Bun.
- Preview settings: `CONVEX_RELEASE_SEED`, `CONVEX_RELEASE_SNAPSHOT` and `CONVEX_RELEASE_ON_DOWNGRADE`.
