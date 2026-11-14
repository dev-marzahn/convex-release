# The release images. Build from the repo root after `vp run -r build`:
#
#   docker build -f images/Dockerfile --target combined -t convex-release .
#
# Targets (each published as its own tag):
#   combined          The default. The Convex backend plus the release
#                     entrypoint: an app's whole Dockerfile is `FROM` this, and
#                     its container runs the backend and applies the release
#                     on start.
#   combined-runtime  The same without the build step, for apps that write their
#                     own multi-stage Dockerfile.
#   oneshot           A small image that applies the release to a separate
#                     backend (CONVEX_URL) and exits.
#   oneshot-runtime   The same without the build step.
#
# The backend is pinned: the push format follows its version, so each
# convex-release release is tested against exactly one backend build. Convex
# tags backend images by commit; bump this, run `bun run e2e`, release.
ARG BACKEND_IMAGE=ghcr.io/convex/convex-backend:d1fcbeaf939502a23a0f4b7e9095a12e84866294
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${BACKEND_IMAGE} AS backend

FROM ${BACKEND_IMAGE} AS combined-runtime
COPY packages/convex-release/dist/image/entrypoint.mjs /convex/release.mjs
COPY images/onbuild.sh /convex/onbuild.sh
ENTRYPOINT ["node", "/convex/release.mjs"]
HEALTHCHECK --interval=5s --start-period=10s --retries=1000000 CMD test -f /tmp/convex-ready

FROM combined-runtime AS combined
# Runs in the app's build. The app's source is mounted for this step only, so
# neither it nor node_modules ends up in the app image: just /convex/app.
ONBUILD RUN --mount=type=bind,target=/convex/src,rw \
    --mount=type=bind,from=oven/bun:1.4.4,source=/usr/local/bin/bun,target=/usr/local/bin/bun \
    --mount=type=cache,target=/root/.bun/install/cache \
    --mount=type=cache,target=/root/.npm \
    /convex/onbuild.sh

FROM ${NODE_IMAGE} AS oneshot-runtime
# Derives the admin key from the backend's INSTANCE_NAME and INSTANCE_SECRET.
COPY --from=backend /convex/generate_key /convex/generate_key
COPY packages/convex-release/dist/image/entrypoint.mjs /convex/release.mjs
COPY images/onbuild.sh /convex/onbuild.sh
WORKDIR /convex
ENTRYPOINT ["node", "/convex/release.mjs"]

FROM oneshot-runtime AS oneshot
ONBUILD RUN --mount=type=bind,target=/convex/src,rw \
    --mount=type=bind,from=oven/bun:1.4.4,source=/usr/local/bin/bun,target=/usr/local/bin/bun \
    --mount=type=cache,target=/root/.bun/install/cache \
    --mount=type=cache,target=/root/.npm \
    /convex/onbuild.sh
