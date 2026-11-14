# convex-release

[![npm](https://img.shields.io/npm/v/@dev-marzahn/convex-release)](https://www.npmjs.com/package/@dev-marzahn/convex-release)
[![CI](https://github.com/dev-marzahn/convex-release/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-marzahn/convex-release/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Versioned data migrations for [Convex](https://convex.dev), and Docker images that run them when a self-hosted app starts.

Change your schema, write the data change as a numbered file, and deploy. convex-release pushes your code, runs the migrations the deployment hasn't run, and then checks every document against the schema.

```ts
// convex/migrations/0001_rename_body_to_text.ts
import { defineMigration } from './_generated';

export default defineMigration({
  table: 'messages',
  migrateOne: (ctx, doc) => {
    if (typeof doc.body !== 'string') return;
    return { text: doc.body, body: undefined };
  },
});
```

```sh
npx convex-release deploy
```

## Features

- **Migrations in order.** Each file runs once per deployment, in number order, on top of [`@convex-dev/migrations`](https://www.convex.dev/components/migrations). A deployment several versions behind runs all the ones it missed.
- **Schema validation after the data moves.** The deploy pushes with validation off, migrates, then pushes again with validation on. The backend rejects that second push if any document doesn't match.
- **Downgrade protection.** A deploy stops before pushing anything when the deployment has finished a migration your checkout doesn't have.
- **Typed seeding.** `defineSeed` fills an empty deployment with [Faker](https://fakerjs.dev) data typed by your schema.
- **Self-hosted images.** Your `Dockerfile` is one `FROM` line. The container applies the release on start and reports healthy once the data matches the schema. A one-shot variant deploys to a backend in another container and exits.
- **Preview environments.** Containers can seed an empty preview, import a `convex export` snapshot, or reset when a branch renumbers a migration.
- **CI checks.** `verify` fails a pull request that removes or renumbers a shipped migration. `test-upgrade` starts the previous image, gives it data, and upgrades it to the new one in throwaway containers.

## Quick start

In a Convex project where `npx convex dev` has run once:

```sh
npx @dev-marzahn/convex-release init      # installs the packages and mounts the migrations component
npx convex-release new "rename body to text" --table messages
npx convex-release dev                    # in place of `npx convex dev`
npx convex-release deploy                 # in place of `npx convex deploy`
```

`init --docker` adds a `Dockerfile` and `compose.yaml`, and `init --ci` adds GitHub Actions workflows.

## Documentation

The [package README](packages/convex-release/README.md) is the full reference:

- [Writing migrations](packages/convex-release/README.md#writing-migrations)
- [Seeding](packages/convex-release/README.md#seeding)
- [What a deploy does](packages/convex-release/README.md#what-a-deploy-does)
- [Commands](packages/convex-release/README.md#commands)
- [Self-hosted images](packages/convex-release/README.md#self-hosted-images)
- [Preview environments](packages/convex-release/README.md#preview-environments)
- [CI](packages/convex-release/README.md#ci)
- [Limits](packages/convex-release/README.md#limits)

[`examples/basic`](examples/basic) has three migrations and two seeds.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
