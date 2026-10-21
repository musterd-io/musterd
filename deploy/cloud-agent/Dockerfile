# The cloud agent image (ADR 647 phase 1 + 2b): one Fly machine per hosted seat, running on
# musterd compute. Two modes, one image (README):
#   hosted — against a hosted (Cloud) team: no daemon, no team store (design §4.1b); the host
#            loop polls the hosted server over HTTPS and provisions under the sponsor host key.
#   hub    — against a laptop hub (ADR 689): the machine runs its OWN daemon as a joiner,
#            enrolled at the hub over the tailnet, and the host loop polls that daemon.
#
#   fly deploy --config deploy/cloud-agent/fly.toml --app musterd-agent-<seat>
#
# Build context is the repo root: the CLI is built from THIS checkout, so the seat runs the
# build you deployed. tailscale and setpriv are only used in hub mode; in both modes the
# entrypoint drops to the unprivileged `seat` user before anything of the seat's runs (ADR 390).
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
      util-linux \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
       > /usr/share/keyrings/tailscale-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/debian bookworm main" \
       > /etc/apt/sources.list.d/tailscale.list \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       > /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh tailscale \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:/app/node_modules/.bin:$PATH
ENV COREPACK_HOME=/opt/corepack

# The seat's identity on the machine: an unprivileged user. In hub mode only the tailnet needs
# root, and only in the entrypoint's root phase; a woken model running as root is the thing this
# image must not offer, so the entrypoint drops to `seat` (setpriv) before the seat phase.
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

# Root here, for the hub-mode tailnet only; entrypoint.sh drops to `seat` at once otherwise.
ENTRYPOINT ["bash", "/app/deploy/cloud-agent/entrypoint.sh"]
