# The image Glama builds to inspect and score musterd's MCP server (lane 01M6S9N6HK). Glama runs the
# container and speaks MCP over its stdin/stdout; start.sh stands up a throwaway team on a loopback
# daemon, then hands stdio to @musterd/mcp. No secrets, no network beyond loopback (PRIVACY.md).
#
#   docker build -f deploy/glama/Dockerfile -t musterd-glama .
#   docker run -i --rm musterd-glama
#
# Build context is the repo root (.dockerignore governs it, like every image here).
FROM node:22-bookworm-slim

# python3/make/g++ exist only for better-sqlite3's node-gyp build during pnpm install.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV COREPACK_HOME=/opt/corepack
WORKDIR /app
COPY . .

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @musterd/cli... --filter @musterd/mcp... --filter '!@musterd/web' build \
  && chmod -R a+rX /opt/corepack /app \
  && useradd --uid 1001 --create-home --shell /bin/bash mcp

USER mcp
ENTRYPOINT ["bash", "/app/deploy/glama/start.sh"]
