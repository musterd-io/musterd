# The musterd Cloud server image (cloud increment 1D, lane 01M3Z43NHT): the daemon in cloud mode
# (`MUSTERD_MODE=cloud`, docs/architecture/03-server.md §Cloud mode) on Fly, behind Cloudflare. The
# same image runs the migrate step in the separate migrate app before every rollout (spec §6), so the
# schema and the code that serves it are always the same build.
#
# Build context is the repo root. Do not run `fly deploy` by hand; `scripts/cloud/deploy.mjs` runs the
# whole sequence: build, push, migrate, roll.
#
# No secret is baked in. The serving app gets its database URLs as Fly secrets at runtime, and the
# migrate app gets the owner URLs (scripts/cloud/provision-neon.mjs).

FROM node:22-bookworm-slim AS build
# better-sqlite3 is a native dependency of @musterd/server even though cloud mode never opens a file.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter "@musterd/cli..." --filter "@musterd/web" build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "packages/cli/dist/bin.js", "serve"]
