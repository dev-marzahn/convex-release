# convex-release

[![npm](https://img.shields.io/npm/v/@dev-marzahn/convex-release)](https://www.npmjs.com/package/@dev-marzahn/convex-release)
[![CI](https://github.com/dev-marzahn/convex-release/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-marzahn/convex-release/actions/workflows/ci.yml)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](https://github.com/dev-marzahn/convex-release/blob/main/LICENSE)

Versioned data migrations for [Convex](https://convex.dev), and Docker images that run them when a self-hosted app starts.

You change your schema, write the data change as a numbered file, and deploy. `convex-release deploy` pushes your code, runs the migrations the deployment hasn't run yet, and checks every document against your schema:

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
npx @dev-marzahn/convex-release deploy
```

The images do the same when a self-hosted container starts, so someone who runs your app upgrades it by changing the image tag.

- **Migrations in order.** A deployment several versions behind runs every migration it missed, in number order. Progress and batching come from [`@convex-dev/migrations`](https://www.convex.dev/components/migrations).
- **Schema validation after the data moves.** The deploy pushes with validation off, migrates, then pushes again with validation on. The backend rejects that second push if a document doesn't match.
- **Downgrade protection.** A deploy stops before pushing anything when the deployment has finished a migration your checkout doesn't have.
- **Typed seeding.** `defineSeed` fills an empty deployment with [Faker](https://fakerjs.dev) data typed by your schema.
- **Self-hosted images.** Your `Dockerfile` is one `FROM` line, and the container reports healthy once the data matches the schema. A one-shot variant deploys to a backend in another container and exits.
- **Hooks and backups.** The images can run your commands before the first push and after the release, and export the deployment before they migrate it.
- **Preview environments.** A preview container can seed itself, import a `convex export` snapshot, or reset when a branch renumbers a migration.
- **CI checks.** `verify` fails a pull request that removes or renumbers a shipped migration. `test-upgrade` upgrades the previous image's data to the new one in throwaway containers.

## Contents

- [Quick start](#quick-start)
- [Writing migrations](#writing-migrations)
- [Seeding](#seeding)
- [What a deploy does](#what-a-deploy-does)
- [Commands](#commands)
- [Self-hosted images](#self-hosted-images)
- [Preview environments](#preview-environments)
- [Predeploy checks](#predeploy-checks)
- [CI](#ci)
- [Limits](#limits)

## Quick start

In a Convex project with a deployment set up (`npx convex dev` has run once):

```sh
npx @dev-marzahn/convex-release init
```

`init` installs `@dev-marzahn/convex-release` and `@convex-dev/migrations` with your package manager and mounts the migrations component in `convex/convex.config.ts`. It creates that file if needed, and prints the two lines to add if it can't edit it. It also writes `convex/migrations/_generated.ts`, which your migrations import.

In a terminal, `init` then asks whether to write a `Dockerfile`, `.dockerignore` and `compose.yaml` for an image, and GitHub Actions workflows. `--docker` and `--ci` answer yes without asking; outside a terminal, it writes neither unless you pass them. It leaves any of those files that already exist as they are.

Change your schema, then describe the data change:

```sh
npx convex-release new "rename body to text" --table messages
```

`new` writes `convex/migrations/0001_rename_body_to_text.ts` from a template for you to fill in.

Develop with `convex-release dev` in place of `npx convex dev`. It deploys to your dev deployment once, then hands over to `convex dev`, which pushes your code but runs no migrations. After you add or change a migration, restart `convex-release dev`. Deploy with `convex-release deploy` in place of `npx convex deploy`.

[`examples/basic`](https://github.com/dev-marzahn/convex-release/tree/main/examples/basic) is an app with three migrations and two seeds.

## Writing migrations

A migration lives in `convex/migrations/`, in a file named `<number>_<name>.ts` (or `.js`). The name uses lowercase letters, digits and underscores, and each number appears once. Any other `.ts` or `.js` file there makes the commands fail, except files starting with `_` (such as `_helpers.ts`), test files and `.d.ts` files. The numbers set the order. The deployment records each migration by its file name, so renaming or renumbering a file makes it a different migration.

In this README, a version of your app means the set of migrations a checkout or image contains. Package versions and image tags are labels for it: a deployment compares migrations, and refuses a version that lacks one it has finished.

The examples below migrate messages that stored the author's name as a string and their text as `body`, to this schema:

```ts
// convex/schema.ts
export default defineSchema({
  users: defineTable({ name: v.string() }).index('by_name', ['name']),
  messages: defineTable({ text: v.string(), length: v.number(), authorId: v.id('users') }),
});
```

`0001_rename_body_to_text.ts` is the migration at the top of this README. `migrateOne` runs once per document. Return the fields to change, or nothing to leave the document as it is. Setting a field to `undefined` removes it. `ctx` is a mutation context, so a migration can read and write other tables:

```ts
// convex/migrations/0003_author_to_users.ts (0002 sets `length`)
import { userByName } from '../users'; // your helper: finds or inserts a user
import { defineMigration } from './_generated';

export default defineMigration({
  table: 'messages',
  migrateOne: async (ctx, doc) => {
    if (typeof doc.author !== 'string') return;
    return { authorId: await userByName(ctx, doc.author), author: undefined };
  },
});
```

- `doc` can be in any older shape. Its type has your current schema's fields as optional, plus any other fields as `unknown`, so TypeScript makes you check before you use `doc.body`.
- A migration can run twice on the same document, after a failed batch or a restart. Check whether the document still needs the change, as both examples do.
- Don't delete or renumber a shipped migration (one merged into the branch you deploy from). A deployment on any older version of your app upgrades by running every migration it hasn't finished, in order. Removing one breaks upgrades from versions before it.
- Each migration sees the new schema and indexes, because the deploy pushes them before it runs migrations. A migration can use a table or index added in the same version, as `0003` does with `users`.

`defineMigration` also takes `batchSize` (default 100), `parallelize`, and `customRange` to visit part of a table.

`convex/migrations/_generated.ts` wires the files up, and `convex/seeds/_generated.ts` does the same for seeds. `new`, `codegen`, `dev` and `deploy` rewrite both; commit them like Convex's `_generated/` folder.

## Seeding

Seeds fill an empty deployment with test data: your dev deployment, a preview, or the data `test-upgrade` starts from. Each file in `convex/seeds/` is one seed. They run in the order of their number prefix, and files without one run last, by name:

```sh
npx convex-release new users --seed --table users
```

```ts
// convex/seeds/01_users.ts
import { defineSeed } from './_generated';

export default defineSeed('users', {
  count: 20,
  fields: {
    name: ({ faker, i }) => `${faker.person.fullName()} ${i}`,
  },
});
```

```ts
// convex/seeds/02_messages.ts
import { defineSeed } from './_generated';

export default defineSeed('messages', {
  count: 250,
  fields: {
    text: ({ faker }) => faker.lorem.sentence(),
    length: ({ doc }) => doc.text!.length,
    authorId: ({ ref }) => ref('users'),
  },
});
```

`fields` takes the table's schema type, so TypeScript flags a missing field or a value of the wrong type. A field gets a fixed value or a function that receives:

- `faker`: a [Faker](https://fakerjs.dev) instance, seeded per document, so each run writes the same field values.
- `i`: the document's number in this seed, from 0.
- `doc`: the fields generated so far, in the order you list them.
- `ref(table)`: the id of a random document in that table, from its first 1000. Seed that table in an earlier file.

For anything else, pass a function. It runs as one mutation:

```ts
// convex/seeds/03_admin.ts
import { defineSeed } from './_generated';

export default defineSeed(async (ctx, { faker }) => {
  const admin = await ctx.db.insert('users', { name: 'Admin' });
  const text = faker.lorem.paragraph();
  await ctx.db.insert('messages', { text, length: text.length, authorId: admin });
});
```

By default, seeds only run on a deployment with no documents in its tables. `convex-release dev` runs them after the deploy when the dev deployment is empty, `convex-release seed` runs them by hand (`--force` seeds a deployment with data), and the images run them when you set `CONVEX_RELEASE_SEED=true`.

A table seed writes 100 documents per transaction (`batchSize` changes that), and the whole run is one action, so it has an action's 10-minute limit.

## What a deploy does

`dev`, `deploy` and the images run the same steps:

1. Check that the deployment has no finished migrations this version doesn't know, then run your dependencies' [predeploy checks](#predeploy-checks), and stop before pushing anything if either fails.
2. Push your code with a copy of your schema that sets `schemaValidation: false`; your files don't change. Your new functions and indexes go live, though existing documents may not match the schema yet, and the backend doesn't check new writes against it either.
3. Run the pending migrations until they finish.
4. Push again with validation on. The backend checks every document against the schema and rejects the push if one doesn't match.

Step 1 stops when a newer version of your app ran migrations this one lacks, or someone renamed or renumbered a finished migration, or a predeploy check fails. It also stops when it can't read what the deployment has recorded. When a version has no migration files at all, the images push once, with validation on; `dev` and `deploy` still push twice. The images can also take a backup and run your hooks around these steps; see [Settings](#settings).

If a migration throws, the deploy stops during step 3, skips step 4 and reports the error. Your new code stays deployed with validation off. Fix the cause in the same file and deploy again: the migration continues from the batch that failed. A renamed file starts over as a new migration, and the old one stays recorded as failed.

`convex-release check` runs step 4 as a dry run, without changing anything. It tells you whether your schema accepts the data as it is. If not, it lists the pending migrations, which run first and may fix it, or exits with code 1 when there are none, so you need to write one. It also runs the predeploy checks and exits with code 1 when one fails.

## Commands

| Command                       | What it does                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`                        | Sets up the packages and the migrations component. `--docker` adds the Docker files, `--ci` the GitHub Actions workflows.                                                |
| `new <name> --table <table>`  | Creates the next numbered migration. `--seed` creates the next seed file instead.                                                                                        |
| `dev`                         | Deploys to your dev deployment, seeds it if it's empty, then runs `convex dev`. `--once` stops after the deploy.                                                         |
| `seed`                        | Runs the seeds on a deployment without data. `--force` seeds one with data.                                                                                              |
| `deploy`                      | Deploys to the deployment `convex deploy` would use: prod, the one a `CONVEX_DEPLOY_KEY` names, a self-hosted URL, or `--deployment <name>`.                             |
| `status`                      | Lists each migration as done, running, pending, failed or canceled on the deployment, with document counts, and flags recorded ones your checkout doesn't have.          |
| `check`                       | Dry-runs the schema against the deployment's data, and runs the predeploy checks.                                                                                        |
| `verify`                      | Compares the migrations with a base branch. Needs no deployment.                                                                                                         |
| `codegen`                     | Rewrites `convex/migrations/_generated.ts` and `convex/seeds/_generated.ts`.                                                                                             |
| `build`                       | Builds the image, tagged `<name>:<version>` from package.json, or `<name>-oneshot:<version>` with `--oneshot`. `--tag` sets another.                                     |
| `test-upgrade --from <image>` | Upgrades a previous version's data to this one in throwaway containers.                                                                                                  |
| `bundle [dir]`                | Writes what an image applies: the push requests (`push.json`, `push.relaxed.json`), `release.json` and the predeploy check modules (`checks/`). The image build runs it. |

`status`, `check` and `seed` take `--prod` and `--deployment <name>` and default to your dev deployment. `status`, `check`, `seed` and `verify` take `--json`.

`dev`, `deploy` and `check` take `--skip-check <package>`, as often as needed, to skip that dependency's [predeploy check](#predeploy-checks).

`dev` and `deploy` take `--timeout <seconds>`: when it runs out, the command exits with code 1 and the migrations keep going on the deployment. The next deploy waits for them and finishes. `test-upgrade --timeout` sets how long each version may take to become ready (default 600 seconds).

Outside a terminal, the commands print one line per step instead of spinners, and `new` fails instead of asking for a missing argument. On GitHub Actions, `dev`, `deploy` and `status` add a migrations table to the job summary, and `test-upgrade` adds the upgrade's duration and log.

## Self-hosted images

The combined image holds the Convex backend, your functions and your migrations. It applies them when its container starts and reports healthy once the data matches the schema. The [one-shot image](#one-shot-image) does the same for a backend in another container, and [your own Dockerfile](#your-own-dockerfile) covers builds you control.

For a self-hosted backend, pick one way to deploy: an image, or `convex-release deploy` against the backend. With both, whichever ran last decides the code, and once a `deploy` from a newer checkout has finished a migration, every image without it refuses to start. `init --ci` writes workflows for one or the other.

Your `Dockerfile` is one line:

```dockerfile
FROM ghcr.io/dev-marzahn/convex-release:100.2.1
```

The build installs your dependencies with the package manager your lockfile belongs to: npm, pnpm, Yarn or Bun, and Bun when there's no lockfile. It then bundles your `convex/` folder. Neither your source nor `node_modules` ends up in the image.

For Yarn, the build needs two things:

- With Yarn 2 or later, `nodeLinker: node-modules` in `.yarnrc.yml`.
- `convex-helpers` in your dependencies, since Yarn doesn't install peer dependencies. `init` adds it.

The image tag has to match the `@dev-marzahn/convex-release` version you have installed, and the build fails when it doesn't. `init --docker` writes the matching tag; change it when you update the package.

Build the image with `convex-release build` or `docker build .` and push it to your registry, or let the [`image.yml` workflow](#ci) do both.

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

To upgrade, change the tag and run `docker compose up -d`. A tag older than the data makes the container exit before it pushes anything; go back to the newer tag. A failing [predeploy check](#predeploy-checks) does the same. Once you've confirmed the release is safe anyway, set `CONVEX_RELEASE_SKIP_CHECKS` to the package names to skip, comma-separated.

If a migration throws in the container, the container stops its backend and exits with code 1, and `restart: unless-stopped` retries it on every start. Unlike with `convex-release deploy`, your whole app is down until a start succeeds, not just the new code. The logs show `[convex-release] deploy failed:` with the error; fix the migration in the same file and ship a new tag. To have a copy of the data from before the upgrade, set [`CONVEX_RELEASE_BACKUP_DIR`](#backups).

### One-shot image

To keep the stock Convex backend in its own container, build the one-shot variant with `convex-release build --oneshot`, or with `FROM ghcr.io/dev-marzahn/convex-release-oneshot:100.2.1`. It deploys your app to the backend at `CONVEX_URL` and exits:

```yaml
services:
  backend:
    image: ghcr.io/convex/convex-backend:d1fcbeaf939502a23a0f4b7e9095a12e84866294
    environment:
      INSTANCE_NAME: my_app
      INSTANCE_SECRET: ${INSTANCE_SECRET:?set INSTANCE_SECRET}
    volumes:
      - data:/convex/data
    healthcheck:
      test: curl -f http://localhost:3210/version
  deploy:
    image: ghcr.io/you/my-app-oneshot:1.4.0
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

The backend tag is the build this version of convex-release pins and tests against. It changes with convex-release, so update it when you update the package, not on its own.

`CONVEX_URL` is what switches an image to this mode, so leave it out of the combined image's environment.

The one-shot container derives the admin key from the backend's `INSTANCE_NAME` and `INSTANCE_SECRET`, so you don't handle an admin key. Set `CONVEX_ADMIN_KEY` to use one instead.

### Your own Dockerfile

The `-runtime` tags (`convex-release:100.2.1-runtime`, `convex-release-oneshot:100.2.1-runtime`) skip the automatic build step, for a monorepo or any build you want to control. The image reads its bundle from `/convex/app`:

```dockerfile
FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

FROM ghcr.io/dev-marzahn/convex-release:100.2.1-runtime AS bundle
COPY --from=deps /app /app
WORKDIR /app
RUN node_modules/.bin/convex-release bundle /convex/app

FROM ghcr.io/dev-marzahn/convex-release:100.2.1-runtime
COPY --from=bundle /convex/app/ /convex/app/
```

### Settings

Both images read these from the container's environment. All are optional.

| Variable                         | Effect                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CONVEX_RELEASE_PRE_PUSH`        | A command to run before the first push. See [Hooks](#hooks).                                                                   |
| `CONVEX_RELEASE_POST_APPLY`      | A command to run after the release is applied, before the container reports ready. See [Hooks](#hooks).                        |
| `CONVEX_RELEASE_BACKUP_DIR`      | A folder to export the deployment to before migrating. See [Backups](#backups).                                                |
| `CONVEX_RELEASE_BACKUP_KEEP`     | How many backups to keep in that folder: a whole number, 1 or more. Default 3.                                                 |
| `CONVEX_RELEASE_SKIP_CHECKS`     | Package names, comma-separated, whose [predeploy checks](#predeploy-checks) don't run.                                         |
| `CONVEX_RELEASE_SNAPSHOT`        | A `convex export` zip to import into an empty deployment: a [restore](#backups), or a [preview's](#preview-environments) data. |
| `CONVEX_RELEASE_SEED`            | `true` seeds an empty deployment. For [previews](#preview-environments).                                                       |
| `CONVEX_RELEASE_ON_DOWNGRADE`    | `reset` deletes the data instead of refusing an older release. For [previews](#preview-environments).                          |
| `CONVEX_URL`, `CONVEX_ADMIN_KEY` | The [one-shot image's](#one-shot-image) backend, and an admin key for it.                                                      |

A container started with an invalid setting, such as `CONVEX_RELEASE_BACKUP_KEEP=0`, exits with code 1 before it changes anything.

On every start, the images run these steps in order. Any failure stops the start there:

1. Wait for the backend to answer.
2. Refuse a release older than the data, then run the predeploy checks.
3. Take a backup, if `CONVEX_RELEASE_BACKUP_DIR` is set and migrations are pending.
4. Run the pre-push hook.
5. Push with validation off. With `CONVEX_RELEASE_SNAPSHOT`, import the snapshot into an empty deployment.
6. Run the migrations, then push with validation on.
7. Record the release's version in the deployment (see [The applied version](#the-applied-version)).
8. With `CONVEX_RELEASE_SEED`, run the seeds on an empty deployment.
9. Run the post-apply hook.
10. The combined container reports ready; the one-shot container exits with code 0.

### Hooks

`CONVEX_RELEASE_PRE_PUSH` and `CONVEX_RELEASE_POST_APPLY` name commands for both images to run at steps 4 and 9 above. Use the pre-push hook for deployment variables your functions need from their first push, and the post-apply hook for anything that needs the new functions, such as reference data:

```yaml
environment:
  CONVEX_RELEASE_PRE_PUSH: node /app/hooks.mjs pre-push
  CONVEX_RELEASE_POST_APPLY: node /app/hooks.mjs post-apply
```

- Each command runs with `sh -c`, and inherits the container's environment and output.
- Each command also gets two variables:
  - `CONVEX_URL`: the deployment's URL. That's `http://127.0.0.1:<PORT>` in the combined image, and the one-shot image's own `CONVEX_URL`.
  - `CONVEX_ADMIN_KEY`: an admin key for that deployment, the key the image uses.
- With them, a hook can call the deployment's HTTP API with the header `Authorization: Convex <key>`. Both images have Node, so a hook can be a script that `node` runs.
- A hook that exits with any other code than 0 fails the start, like a failed migration. The log shows `[convex-release] deploy failed: pre-push hook failed (exit 1)`. The combined container stops its backend and exits with code 1 without reporting ready, and the one-shot container exits with code 1.
- The hooks run on every start, so make them safe to repeat.
- The log names each hook as it runs, but never its command or the variables it gets. Don't print the admin key from your hook.

### Backups

With `CONVEX_RELEASE_BACKUP_DIR` set, both images export the deployment before they migrate it. They do this when migrations are pending and the app's tables hold data. Mount a volume or a host folder at that path:

```yaml
environment:
  CONVEX_RELEASE_BACKUP_DIR: /backups
volumes:
  - ./backups:/backups
```

- **File name:** `<UTC yyyymmdd-hhmmss>-<from>-to-<to>.zip`, for example `20261118-090503-1.3.0-to-1.4.0.zip`.
  - `<from>` is the [version](#the-applied-version) the deployment last applied, or `unknown` before one is recorded.
  - `<to>` is this image's version, or `unknown` when your `package.json` has none.
- **Format:** a `convex export` that includes file storage, the format `CONVEX_RELEASE_SNAPSHOT` imports. The image downloads it to `<file>.partial`, and renames it once the download is complete.
- **Retention:** after writing a new backup, the image keeps the newest `CONVEX_RELEASE_BACKUP_KEEP` (default 3) and deletes the older ones. It only deletes files named like its backups; it leaves anything else in the folder alone.
- **A failed backup** stops the start before anything is pushed, with `[convex-release] deploy failed: backup failed: <reason>`. The usual cause is a full disk. The backend writes the export to its own storage before the image downloads it, so the backend's volume needs room too.
- **One backup per upgrade, however many attempts it takes.**
  - After a backup, the deployment records the file's name in its variable `CONVEX_RELEASE_BACKUP`.
  - Every start reuses that backup, until a release applies successfully and clears the record.
  - So a migration that fails in a restart loop never adds backups of half-migrated data. Neither does a fix release you ship while it fails. And retention never deletes the backup taken before the first attempt.
  - If the recorded file is gone from the folder, or never finished downloading, the next attempt takes a new backup.
- **Secrets:** a backup holds all your data, secrets included, in plain text. Keep the folder private, and copy backups off the host.

To restore a backup, start the image on an empty volume with `CONVEX_RELEASE_SNAPSHOT=/backups/<file>`. Once the container is up, remove the setting.

- To go back to the release the backup was taken from, use the `<from>` version's image.
- To retry the upgrade, use the newer image. It runs the migrations again.
- The image only imports into an empty deployment, so a forgotten setting does nothing on later starts.
- Deployment variables aren't part of an export. Set yours again; a pre-push hook does that on every start.
- The import also clears `CONVEX_RELEASE_VERSION` and `CONVEX_RELEASE_BACKUP`, which described the data it replaced.

### The applied version

After step 6, both images record your `package.json` `version` in the deployment variable `CONVEX_RELEASE_VERSION`, carried in the image's `release.json`. If the app has no `version`, the variable is removed.

- Your functions read it as `process.env.CONVEX_RELEASE_VERSION`, for example to show the running release or to compare it with the latest one.
- A pre-push hook sees the previous release's version there, and a post-apply hook sees the new one.
- `convex-release deploy` and `dev` don't set it.

Give each release you ship its own version: the backups are named by it.

## Preview environments

This section covers previews that run your self-hosted image per pull request, each on its own volume. For a Convex Cloud preview deployment, seed it with `convex-release seed --deployment <name>`.

Three settings on the container are meant for previews. Leave all three unset in production, except `CONVEX_RELEASE_SNAPSHOT` while you [restore a backup](#backups):

| Variable                            | Effect                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONVEX_RELEASE_SEED=true`          | Runs your seeds after the deploy when the deployment has no data.                                                                                             |
| `CONVEX_RELEASE_SNAPSHOT=<path>`    | Imports a `convex export` zip (a file in the container, or an `https://` URL) into an empty deployment, then runs the migrations the snapshot hasn't had yet. |
| `CONVEX_RELEASE_ON_DOWNGRADE=reset` | Deletes all data when the deployment has recorded any migration this version doesn't know, finished or failed. Without it, only finished ones stop a start.   |

The reset is for a branch that renames or renumbers a migration after its preview already ran it. Without it, the preview refuses to start until you delete its volume.

A snapshot from a newer version makes the container delete what it imported and exit. Each start imports and checks the snapshot again, so the next start succeeds once `CONVEX_RELEASE_SNAPSHOT` points at an export from this version or an older one.

The snapshot holds the data of wherever you exported it, and the preview runs the pull request's code on it. Export from a staging deployment or strip personal data first.

On a platform with per-pull-request previews, such as Coolify, give the previews their own `INSTANCE_SECRET` and set `CONVEX_RELEASE_SEED=true` and `CONVEX_RELEASE_ON_DOWNGRADE=reset` as preview-only variables. When a push to the pull request starts the new image on the preview's volume, a migration added later in the branch runs on the data the preview already has.

Predeploy checks run before a `CONVEX_RELEASE_SNAPSHOT` import, so they don't see the snapshot's data. With `CONVEX_RELEASE_ON_DOWNGRADE=reset` they run on the emptied deployment.

## Predeploy checks

A library you depend on can refuse a release that would break data already in your deployment. For example, a workflow library can refuse a release that deletes code a running workflow still needs. You don't configure anything: installing the library as a direct dependency is enough.

`dev`, `deploy` and both images run each dependency's check after the migration check in [step 1](#what-a-deploy-does), before anything is pushed. When one fails, the release stops and prints every failure:

```text
A predeploy check refused this release; nothing was pushed.
@acme/workflows: workflow patch "prepare-before-publish" was removed, but 3 running workflows still need its old branch
  - pipeline:run 3f9a…
  - pipeline:run 77c1…
Skip a check with --skip-check <package> only if you've confirmed the release is safe.
```

Nothing changed on the deployment. Fix what the check names, or skip it after you've confirmed the release is safe: `--skip-check <package>` on `dev`, `deploy` and `check`, or `CONVEX_RELEASE_SKIP_CHECKS=<package>,<package>` on an image. Each skip prints a warning naming the package. `convex-release check` runs the checks without deploying.

`convex-release dev` checks only its first push. The pushes `convex dev` makes while it watches aren't checked.

### Writing a check

A library declares its check in its `package.json`:

```json
{ "convex-release": { "predeploy": "./dist/predeploy.mjs" } }
```

The module is one ESM file whose only imports are `node:` built-ins, because the images run it without your users' `node_modules`. Bundle it if it needs more. `convex-release bundle` loads it from an empty folder while the image builds, and fails the build if it imports anything else.

```ts
import type { PredeployCheckContext, PredeployCollectContext, PredeployResult } from '@dev-marzahn/convex-release';

export const protocol = 1;

/** Facts about the release being deployed, from the app's source. Must be plain JSON. */
export async function collect({ projectRoot, convexDir }: PredeployCollectContext) {
  return { patches: await readPatchIds(convexDir) };
}

/** Runs against the deployment before anything is pushed. Must only read. */
export async function check({ facts, query, log }: PredeployCheckContext): Promise<PredeployResult> {
  let blocked: string[];
  try {
    blocked = await query({ componentPath: 'workflows', path: 'patches:blocked' }, { declared: (facts as { patches: string[] }).patches });
  } catch (err) {
    // The release that first adds the library: there's nothing to protect yet.
    if ((err as { code?: string }).code === 'COMPONENT_NOT_DEPLOYED') return { ok: true };
    throw err;
  }
  return blocked.length === 0 ? { ok: true } : { ok: false, message: 'removed patches are still needed', details: blocked };
}
```

- `collect` runs where the app's source is: `dev`, `deploy` and `check`, and `bundle` in the image build, which stores the facts in the image. `check` gets them as `facts`.
- `query` calls a query function in the app, or in a component with `componentPath`. It rejects with `code: 'COMPONENT_NOT_DEPLOYED'` when that component is missing or was unmounted. A failed query rejects with the backend's error message in the images, and with the `convex` CLI's output from a checkout.
- A check only reads. The images refuse to call anything but a query. From a checkout, `convex run` can't tell, so it's on you.
- Each check runs in its own Node process, with only `PATH` in its environment and a 10-minute limit. A check that throws, exits, times out, returns anything but `{ ok: true }` or `{ ok: false, message, details? }`, or exports a `protocol` other than `1` counts as failed.
- The check module comes from the release being deployed, and reads data the deployed release wrote. Keep the queries it calls callable, with the same arguments and result shape, from one version of your library to the next.
- `protocol` is the version of the interface convex-release gives the module. A new protocol means a new major version of convex-release.

## CI

`convex-release init --ci` writes GitHub Actions workflows for how your app deploys. With a `Dockerfile`, it asks whether that's with images or with `convex-release deploy`, and outside a terminal it picks images. Without one, it uses `deploy`. `--deploy-with image` (which needs a `Dockerfile`) or `--deploy-with cli` skips the question. It doesn't overwrite workflows that exist.

`convex.yml` runs `verify` on pull requests. With `cli`, it also runs `deploy` on pushes to your default branch: give it a `CONVEX_DEPLOY_KEY` secret, or `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` for a self-hosted backend.

With `image`, `image.yml` comes along. A tag like `v1.4.0` builds the image, upgrades the previous tag's image to it in throwaway containers, and only then pushes `ghcr.io/<owner>/<repo>:1.4.0` and `:latest` for amd64 and arm64. The first tag has no previous image, so it skips the upgrade test.

### Checking pull requests

`verify` compares `convex/migrations/` with the pull request's target branch (`--base <ref>` picks another). It fails when a pull request removes, renames or renumbers a migration that already shipped, or adds one numbered below a shipped one, since deployments on older versions rely on that order. Editing a shipped migration gets a warning: deployments that already ran it won't run it again. `verify` reads git history alone, so it runs on pull requests from forks without secrets. Check out with `fetch-depth: 0` so the base branch is there.

`check` answers a different question: does your schema accept the data on a real deployment? In CI, it needs that deployment's deploy key; run `check --prod` so the dry run and the status read target the deployment the key names.

### Testing upgrades

`test-upgrade` starts your previous version on a fresh volume and gives it data, then starts the new version on the same volume and waits for it to become healthy:

```sh
npx convex-release test-upgrade --from ghcr.io/you/my-app:1.3.0 \
  --seed 'testing:seed {"count": 5000}' \
  --check testing:verify
```

The previous version gets its data from:

- `--seed` alone: that version's own seeds.
- `--seed <function>`: a function of yours, which has to exist in the `--from` image.
- `--snapshot <zip>`: an export, see [Rehearsing on real data](#rehearsing-on-real-data). The snapshot goes in first, then the seed, if you pass both.

Without any of them, the upgrade runs on an empty deployment. `--check <function>` runs on the new version and should throw when the upgraded data isn't what you expect. The `--seed` and `--check` functions take optional JSON arguments after the name, and they can be internal functions (`internalMutation`, `internalQuery`), so your app's clients can't call them.

Without `--to`, `test-upgrade` builds the current project first. The `--from` and `--to` images have to be combined images, since the test waits for their health check.

### Rehearsing on real data

`--snapshot` imports a `convex export` zip into the previous version before the upgrade, so you see how the migrations handle production data. The time it reports comes from the machine running the test, so treat it as an estimate for production:

```sh
npx convex export --prod --path prod.zip
npx convex-release test-upgrade --from ghcr.io/you/my-app:1.3.0 --snapshot prod.zip
```

The export holds the migrations component's records too, so the rehearsal runs the migrations production hasn't run yet and skips the rest. The snapshot holds your production data: keep it out of public artifacts, and don't run the job on pull requests from forks.

## Limits

- Bundling uses two hidden `convex deploy` flags (`--write-push-request`, `--push-all-modules`), which a new `convex` version can change. convex-release's peer range for `convex` is `^1.50.0`; update convex-release when you update `convex`.
- Between steps 2 and 4 your new code runs against data the migrations haven't reached yet. Write code that handles both shapes until the deploy finishes.
- The images are for self-hosted Convex. `dev` and `deploy` use the `convex` CLI, so they work wherever it does.

## Versioning

Releases follow [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver): the first number is `EPOCH * 100 + MAJOR`, starting at epoch 1, and any change to it can break your app. Minor and patch releases don't. See the [changelog](https://github.com/dev-marzahn/convex-release/blob/main/CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](https://github.com/dev-marzahn/convex-release/blob/main/CONTRIBUTING.md). Report security issues as described in [SECURITY.md](https://github.com/dev-marzahn/convex-release/blob/main/SECURITY.md).

## License

[MPL-2.0](https://github.com/dev-marzahn/convex-release/blob/main/LICENSE). You can use convex-release in closed-source apps and ship it in your images. If you distribute a changed version of its own files, publish those changes under MPL-2.0. Versions up to 100.0.0 were released under MIT.

The images also contain code from the [Convex backend](https://github.com/get-convex/convex-backend), which is licensed under FSL-1.1-Apache-2.0: the whole backend in the combined images, and its admin key generator in the one-shot images.
