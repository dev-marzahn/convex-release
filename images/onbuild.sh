#!/bin/sh
# Runs in an app's image build (the ONBUILD step): installs the app's
# dependencies and bundles its functions and migrations into /convex/app with
# the app's own convex-release, so the bundle matches its generated files.
#
# Package manager: npm with a package-lock.json, otherwise Bun (mounted for
# this step only, so it never lands in the runtime image).
set -e
cd /convex/src
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
elif [ -f bun.lock ] || [ -f bun.lockb ]; then
  bun install --frozen-lockfile
else
  bun install
fi
if [ ! -x node_modules/.bin/convex-release ]; then
  echo "convex-release isn't installed in this app. Add @dev-marzahn/convex-release to its dependencies." >&2
  exit 1
fi
node_modules/.bin/convex-release bundle /convex/app
