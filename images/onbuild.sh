#!/bin/sh
# Runs in an app's image build (the ONBUILD step): installs the app's
# dependencies and bundles its functions and migrations into /convex/app with
# the app's own convex-release, so the bundle matches its generated files.
#
# Package manager, by lockfile: npm, pnpm, Yarn or Bun, and Bun without one.
# Bun and Corepack (which runs pnpm and Yarn) are mounted for this step only,
# so neither lands in the runtime image.
set -e
cd /convex/src
corepack() { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 node /opt/corepack/dist/corepack.js "$@"; }
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
elif [ -f pnpm-lock.yaml ]; then
  corepack pnpm install --frozen-lockfile
elif [ -f yarn.lock ] && head -n 5 yarn.lock | grep -q 'yarn lockfile v1'; then
  corepack yarn install --frozen-lockfile
elif [ -f yarn.lock ]; then
  corepack yarn install --immutable
elif [ -f bun.lock ] || [ -f bun.lockb ]; then
  bun install --frozen-lockfile
else
  bun install
fi
if [ ! -x node_modules/.bin/convex-release ]; then
  echo "convex-release isn't installed in this app's node_modules. Add @dev-marzahn/convex-release to its dependencies; with Yarn, set nodeLinker: node-modules." >&2
  exit 1
fi
node_modules/.bin/convex-release bundle /convex/app
