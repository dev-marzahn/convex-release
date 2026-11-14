# convex-release

Data migrations for [Convex](https://convex.dev), and Docker images that ship them with your app.

You write each migration as a numbered file. `convex-release deploy` pushes your code, runs the migrations the deployment hasn't run yet, and checks every document against your schema. The release images do the same when a self-hosted container starts, so someone who runs your app upgrades it by changing the image tag.

It builds on [`@convex-dev/migrations`](https://www.convex.dev/components/migrations), which tracks progress and runs batches.

## Contents

- [Quick start](#quick-start)
- [Writing migrations](#writing-migrations)
- [What a release does](#what-a-release-does)
- [Commands](#commands)
- [Self-hosted images](#self-hosted-images)
- [CI](#ci)
- [Limits](#limits)

## Quick start

In a Convex project:

```sh
bunx @dev-marzahn/convex-release init
```

`init` installs `@dev-marzahn/convex-release` and `@convex-dev/migrations` with your package manager and mounts the migrations component in `convex/convex.config.ts`. It can also write a `Dockerfile`, `.dockerignore` and `compose.yaml` for a release image. It leaves existing files alone.

Change your schema, then describe the data change:

```sh
bunx convex-release new "rename body to text" --table messages
```

Develop with `convex-release dev` in place of `npx convex dev`. It releases to your dev deployment once, then hands over to `convex dev`. Deploy with `convex-release deploy` in place of `npx convex deploy`.

## Writing migrations

A migration lives in `convex/migrations/`, in a file named `<number>_<name>.ts`. The numbers set the order:

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

`migrateOne` runs once per document. Return the fields to change, or nothing to leave the document as it is. Setting a field to `undefined` removes it. `ctx` is a mutation context, so a migration can read and write other tables:

```ts
// convex/migrations/0003_author_to_users.ts
export default defineMigration({
  table: 'messages',
  migrateOne: async (ctx, doc) => {
    if (typeof doc.author !== 'string') return;
    return { authorId: await userByName(ctx, doc.author), author: undefined };
  },
});
```

A few things to keep in mind:

- `doc` can be in any older shape. Its type has your current schema's fields as optional, plus any other fields as `unknown`, so TypeScript makes you check before you use `doc.body`.
- A migration can run twice on the same document, after a failed batch or a restart. Check whether the document still needs the change, as both examples do.
- Keep shipped migrations and their numbers. A deployment on any older release upgrades by running every migration it hasn't finished, in order. Removing one breaks upgrades from releases before it.
- Each migration sees the new schema and indexes, because the release pushes them before it runs migrations. `0003` above uses the `users` table that its own release adds.

`defineMigration` also takes `batchSize` (default 100), `parallelize`, and `customRange` to visit part of a table.

`convex/migrations/_generated.ts` wires the files up. `new`, `codegen`, `dev` and `deploy` rewrite it; commit it like Convex's `_generated/` folder.

## What a release does

`dev`, `deploy` and the release images run the same steps:

1. Check that the deployment has no finished migrations this release doesn't know. If it has, a newer release ran them, and the release stops before it pushes anything.
2. Push your code with schema validation off. Your new functions and indexes go live, though existing documents don't match the schema yet.
3. Run the pending migrations until they finish.
4. Push again with validation on. The backend checks every document against the schema and rejects the push if one doesn't match.

If a migration throws, the release stops after step 3 and reports the error. Your new code stays deployed with validation off. Fix the cause and release again: the migration continues from the batch that failed.

`convex-release check` runs step 4 as a dry run, without changing anything. It tells you whether your schema accepts the data as it is, and if not, whether a pending migration will run first or you need to write one.

## Commands

| Command                       | What it does                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`                        | Sets up the packages and the migrations component. `--docker` adds the Docker files, `--ci` the GitHub Actions workflows.                     |
| `new <name> --table <table>`  | Creates the next numbered migration.                                                                                                          |
| `dev`                         | Releases to your dev deployment, then runs `convex dev`. `--once` stops after the release.                                                    |
| `deploy`                      | Releases to the deployment `convex deploy` would use: prod, the one a `CONVEX_DEPLOY_KEY` names, a self-hosted URL, or `--deployment <name>`. |
| `status`                      | Lists each migration as done, pending or failed on the deployment, with document counts.                                                      |
| `check`                       | Dry-runs the schema against the deployment's data.                                                                                            |
| `verify`                      | Compares the migrations with a base branch. Needs no deployment.                                                                              |
| `codegen`                     | Rewrites `convex/migrations/_generated.ts`.                                                                                                   |
| `build`                       | Builds the release image as `<package name>:<package version>`. `--oneshot` builds the one-shot variant.                                      |
| `test-upgrade --from <image>` | Upgrades a previous release's data to this one in throwaway containers.                                                                       |
| `bundle [dir]`                | Writes the files a release image applies. The image build runs it.                                                                            |

`status` and `check` take `--prod` and `--deployment <name>` and default to your dev deployment. Both take `--json`. `dev` and `deploy` take `--timeout <seconds>`: when it runs out, the command exits with code 1 and the migrations keep going on the deployment. The next release waits for them and finishes.

Outside a terminal, the commands print one line per step instead of spinners, and `new` fails instead of asking for a missing argument. On GitHub Actions, `deploy` and `status` add a migrations table to the job summary, and `test-upgrade` adds the upgrade's duration and log.

## Self-hosted images

For a self-hosted Convex app you can ship one image that holds the Convex backend plus your functions and migrations. The image applies them when its container starts and reports healthy once the data matches the schema.

Your `Dockerfile` is one line:

```dockerfile
FROM ghcr.io/dev-marzahn/convex-release:0.1.0
```

The build installs your dependencies (Bun, or npm when you have a `package-lock.json`) and bundles your `convex/` folder. Neither your source nor `node_modules` ends up in the image.

```yaml
# compose.yaml
services:
  my-app:
    image: ghcr.io/you/my-app:1.4.0
    ports:
      - '3210:3210'
      - '3211:3211'
    environment:
      INSTANCE_NAME: my_app
      INSTANCE_SECRET: ${INSTANCE_SECRET:?set INSTANCE_SECRET}
    volumes:
      - data:/convex/data
    restart: unless-stopped

volumes:
  data:
```

To upgrade, change the tag and run `docker compose up -d`. A tag older than the data makes the container exit before it pushes anything; go back to the newer tag.

### One-shot image

To keep the stock Convex backend in its own container, build the one-shot variant with `convex-release build --oneshot`, or with `FROM ghcr.io/dev-marzahn/convex-release-oneshot:0.1.0`. It applies your release to the backend at `CONVEX_URL` and exits:

```yaml
services:
  backend:
    image: ghcr.io/convex/convex-backend:<the tag convex-release pins>
    environment:
      INSTANCE_NAME: my_app
      INSTANCE_SECRET: ${INSTANCE_SECRET:?set INSTANCE_SECRET}
    volumes:
      - data:/convex/data
    healthcheck:
      test: curl -f http://localhost:3210/version
  release:
    image: ghcr.io/you/my-app-release:1.4.0
    depends_on:
      backend: { condition: service_healthy }
    environment:
      CONVEX_URL: http://backend:3210
      INSTANCE_NAME: my_app
      INSTANCE_SECRET: ${INSTANCE_SECRET:?set INSTANCE_SECRET}
    restart: 'no'

volumes:
  data:
```

The one-shot container derives the admin key from the backend's `INSTANCE_NAME` and `INSTANCE_SECRET`, so you don't handle an admin key. Set `CONVEX_ADMIN_KEY` to use one instead.

### Your own Dockerfile

The `-runtime` tags (`convex-release:0.1.0-runtime`, `convex-release-oneshot:0.1.0-runtime`) skip the automatic build step, for a monorepo or any build you want to control:

```dockerfile
FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

FROM ghcr.io/dev-marzahn/convex-release:0.1.0-runtime AS bundle
COPY --from=deps /app /app
RUN /app/node_modules/.bin/convex-release bundle /convex/app

FROM ghcr.io/dev-marzahn/convex-release:0.1.0-runtime
COPY --from=bundle /convex/app/ /convex/app/
```

## CI

`convex-release init --ci` writes two GitHub Actions workflows. Edit them like any other workflow.

`convex.yml` runs `verify` on pull requests and `deploy` on pushes to your default branch. Give it a `CONVEX_DEPLOY_KEY` secret, or `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` for a self-hosted backend.

`release-image.yml` comes along when the project has a `Dockerfile`. A tag like `v1.4.0` builds the image, upgrades the previous tag's image to it in throwaway containers, and only then pushes `ghcr.io/<owner>/<repo>:1.4.0` and `:latest` for amd64 and arm64.

### Checking pull requests

`verify` compares `convex/migrations/` with the pull request's target branch (`--base <ref>` picks another). It fails when a pull request removes, renames or renumbers a migration that already shipped, or adds one numbered below a shipped one, since deployments on older releases rely on that order. Editing a shipped migration gets a warning: deployments that already ran it won't run it again. `verify` reads git history alone, so it runs on pull requests from forks without secrets. Check out with `fetch-depth: 0` so the base branch is there.

`check` answers a different question: does your schema accept the data on a real deployment? It needs that deployment's deploy key.

### Testing upgrades

`test-upgrade` starts your previous release on a fresh volume, runs your seed function, then starts the new release on the same volume and waits for it to become healthy:

```sh
bunx convex-release test-upgrade --from ghcr.io/you/my-app:1.3.0 \
  --seed 'testing:seed {"count": 5000}' \
  --check testing:verify
```

Without `--to`, it builds the current project first. `--seed` and `--check` take a function name and optional JSON arguments; `--check` should throw if the data looks wrong. Both images have to be combined images, since the test waits for their health check.

### Rehearsing on real data

`--snapshot` imports a `convex export` zip into the previous release before the upgrade, so you see how the migrations handle production data and how long they take:

```sh
npx convex export --prod --path prod.zip
bunx convex-release test-upgrade --from ghcr.io/you/my-app:1.3.0 --snapshot prod.zip
```

The export holds the migrations component's records too, so the rehearsal runs the migrations production hasn't run yet and skips the rest. The tests use self-hosted exports; Convex Cloud exports share the format but haven't been tried yet. The snapshot holds your production data: keep it out of public artifacts, and don't run the job on pull requests from forks.

## Limits

- Bundling uses two hidden `convex deploy` flags (`--write-push-request`, `--push-all-modules`). Each convex-release release pins the backend image it tests against and supports `convex` 1.50 and later.
- Between steps 2 and 4 your new code runs against data the migrations haven't reached yet, as with any online Convex migration. Write code that handles both shapes until the release finishes.
- The images are for self-hosted Convex. `dev` and `deploy` use the `convex` CLI, so they work wherever it does; the end-to-end tests cover self-hosted deployments.

## License

MIT
