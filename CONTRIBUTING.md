# Contributing

Bug reports, fixes and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach before you write it.

## Setup

You need [Bun](https://bun.sh) 1.4, Node 22.18 or later and, for the end-to-end tests, Docker.

```sh
bun install
bun run ready   # build, then lint, format check and type check, then unit tests
```

The repo uses [Vite+](https://viteplus.dev): `vp check` runs Oxfmt, Oxlint and the TypeScript 7 type check, and `vp check --fix` formats. CI runs `bun run ready` and the end-to-end tests on every pull request.

## Repository

| Path                      | Contents                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/convex-release` | The npm package: the CLI, the libraries the generated migrations and seeds files import, and the release images' entrypoint. |
| `images/`                 | The Dockerfile for the release images and the build step they run in an app's build.                                         |
| `examples/basic`          | An app with three migrations and two seeds.                                                                                  |
| `e2e/`                    | Fixture apps v1 to v4 and the script that builds them from the images and upgrades them on real data.                        |

## End-to-end tests

```sh
bun run e2e                 # all scenarios, a few minutes
bun run e2e steps oneshot   # only the named scenarios
```

The script builds the package and the base images, builds the fixture apps from them, and upgrades v1 through v4 on one volume.

## Pull requests

- Run `bun run ready` before you push. Run `bun run e2e` too if you touched `images/`, `src/image/` or the deploy steps.
- Add a test for a bug fix or a new option.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for a change users will notice.
- If you change how a command behaves, update [README.md](README.md) in the same pull request. It's the only README: packing the package copies it, and `LICENSE`, into `packages/convex-release`.

## Backend version

The images pin a Convex backend build in `images/Dockerfile`. To move to a newer one, change `BACKEND_IMAGE`, update the tag in README.md (a unit test checks they match), and run `bun run e2e`.

## Releasing

Maintainers release from `main`:

1. Pick the version by [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. Bump the first number by one for a breaking change, and to the next hundred for a new epoch.
2. Set `version` in `packages/convex-release/package.json` and the image tags in README.md, and move the "Unreleased" changelog entries under the new version.
3. Push a tag `v<version>`. The [release workflow](.github/workflows/release.yml) checks that the tag matches the package version, runs the checks, pushes the four images to ghcr.io for amd64 and arm64, then publishes the package to npm.
