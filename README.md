# convex-release

Data migrations and self-hosted Docker releases for Convex apps. The package's [README](packages/convex-release/README.md) covers how to use it.

## Repository

| Path                      | Contents                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/convex-release` | The npm package: the CLI, the libraries the generated migrations and seeds files import, and the release images' entrypoint. |
| `images/`                 | The Dockerfile for the release images and the build step they run in an app's build.                                         |
| `examples/basic`          | An app with three migrations and two seeds.                                                                                  |
| `e2e/`                    | Fixture apps v1 to v4 and the script that builds them from the images and upgrades them on real data.                        |

## Development

You need [Bun](https://bun.sh) 1.4 and, for the end-to-end tests, Docker.

```sh
bun install
bun run ready   # build, then lint, format check and type check, then unit tests
bun run e2e     # end-to-end upgrade scenarios (takes a few minutes)
bun run e2e steps oneshot   # the named scenarios
```

The repo uses [Vite+](https://viteplus.dev): `vp check` runs Oxfmt, Oxlint and the TypeScript 7 type check; `vp check --fix` formats.

The images pin a Convex backend build in `images/Dockerfile`. To move to a newer one, change `BACKEND_IMAGE`, run `bun run e2e`, and release.
