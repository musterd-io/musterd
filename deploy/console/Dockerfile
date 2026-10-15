# The musterd console (ADR 615): app.musterd.io. Built from the repo root:
#   fly deploy --config deploy/console/fly.toml  (through scripts/cloud/deploy.mjs)
# Only @musterd/console and what it depends on (@musterd/protocol) are built.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile --filter "@musterd/console..." \
  && pnpm --filter "@musterd/console..." build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "packages/console/dist/bin.js", "serve"]
