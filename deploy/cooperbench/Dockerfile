# The CooperBench run machine (lane 01M5AQE75K). One Fly Machine, a full Firecracker VM, so dockerd
# runs inside it: CooperBench starts every agent in its own task container. The image carries
# CooperBench at a pinned commit, this checkout's musterd (built and packed for the agent
# containers, pack.sh), Redis for the plain coop arm, and the musterd_cooperbench adapter.
#
# Build context is the repo root:
#   fly deploy --config deploy/cooperbench/fly.toml --dockerfile deploy/cooperbench/Dockerfile .
FROM node:22-bookworm

ARG COOPERBENCH_COMMIT=63b9d44

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg iptables jq python3 python3-venv python3-pip redis-server \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io \
  && rm -rf /var/lib/apt/lists/*

# musterd from this checkout: the host-side CLI that runs each pair's daemon, and the packed
# tarballs the agent containers install (mounted read-only at /opt/musterd-pack).
WORKDIR /app
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && bash scripts/research/cooperbench/pack.sh /opt/musterd-pack \
  && ln -s /app/packages/cli/dist/bin.js /usr/local/bin/musterd && chmod +x /app/packages/cli/dist/bin.js

# For gate_smoke.py on the machine: the packed seat-side musterd in its own prefix (what a container
# gets), and Claude Code to drive it. The agent containers install their own copies.
RUN npm install -g --prefix /opt/musterd-seat --ignore-scripts --no-audit --no-fund /opt/musterd-pack/musterd-*.tgz \
  && npm install -g --no-audit --no-fund @anthropic-ai/claude-code

# CooperBench at the commit the adapter was written and tested against. Its openhands-sdk dependency
# needs Python >= 3.12 and bookworm ships 3.11, so the venv uses a uv-managed 3.12.
COPY --from=ghcr.io/astral-sh/uv:0.5.31 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN git clone https://github.com/cooperbench/CooperBench.git /opt/cooperbench \
  && git -C /opt/cooperbench checkout --quiet "${COOPERBENCH_COMMIT}" \
  && uv venv --python 3.12 /opt/cb-venv \
  && uv pip install --quiet --python /opt/cb-venv/bin/python -e /opt/cooperbench

ENV PATH=/opt/cb-venv/bin:$PATH \
    PYTHONPATH=/app/scripts/research/cooperbench \
    COOPERBENCH_EXTERNAL_AGENTS=musterd_cooperbench.adapter \
    MUSTERD_PACK_DIR=/opt/musterd-pack \
    MUSTERD_BIN=musterd

ENTRYPOINT ["bash", "/app/deploy/cooperbench/entrypoint.sh"]
