# The cloud agent image (ADR 647 phase 1): one Fly machine per hosted seat, running on musterd
# compute against a hosted (Cloud) team. It is NOT a daemon and holds no team store (design
# §4.1b): the host loop polls the hosted server over HTTPS, provisions the seat under the
# sponsor host key (ADR 648), and runs the resident engine in the seat's workspace on the volume.
#
#   fly deploy --config deploy/cloud-agent/fly.toml --app musterd-agent-<seat>
#
# Build context is the repo root: the CLI is built from THIS checkout, so the seat runs the
# build you deployed. No tailscale, no inbound port, nothing runs as root.
FROM node:22-bookworm-slim

# python3/make/g++ exist only for better-sqlite3's node-gyp build during pnpm install.
# git + gh + openssh are what a seat needs to do its work; curl/ca-certificates for HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      openssh-client \
      procps \
      python3 \
      make \
      g++ \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       > /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:/app/node_modules/.bin:$PATH
ENV COREPACK_HOME=/opt/corepack

# The seat's identity on the machine: an unprivileged user; nothing here needs root (no
# tailnet, no daemon port). A woken model running as root is the thing this image must not offer.
RUN useradd --uid 1001 --no-create-home --shell /bin/bash seat

WORKDIR /app
COPY . .

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @musterd/cli... --filter '!@musterd/web' build \
  && ln -s /app/packages/cli/dist/bin.js /usr/local/bin/musterd \
  && chmod +x /app/packages/cli/dist/bin.js \
  && chmod -R a+rX /opt/corepack /app

# Everything that must outlive the container lives under /data (the Fly volume): HOME is moved
# there so the host registry, the seat binding and the workspace survive a redeploy.
ENV HOME=/data/home

USER seat
ENTRYPOINT ["bash", "/app/deploy/cloud-agent/entrypoint.sh"]
