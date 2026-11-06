# Glama image

[Glama](https://glama.ai/mcp/servers/musterd-io/musterd) scores an MCP server only once it can build and run it. This image lets it do that.
`start.sh` starts a musterd daemon on loopback, creates a throwaway team `demo` with one agent seat `inspector`, mints that seat's key, and hands stdin/stdout to `@musterd/mcp`.
Everything lives in a temp dir and dies with the container.
It needs no secrets and makes no outbound connections. Telemetry stays off ([PRIVACY.md](../../PRIVACY.md)).

## Check it locally

```bash
docker build -f deploy/glama/Dockerfile -t musterd-glama .
docker run -i --rm musterd-glama
```

Then send MCP `initialize` and `tools/list` on stdin. The server lists every musterd tool.
Without Docker, after `pnpm -r build`, run `bash deploy/glama/start.sh` the same way.

## What to enter on Glama

Glama builds its own image from the fields on the server's **Admin → Dockerfile** page; a maintainer of the listing (`glama.json`) fills them in:

- **Node.js version:** 22
- **Build steps:** `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @musterd/cli... --filter @musterd/mcp... --filter '!@musterd/web' build`
- **CMD arguments:** `bash deploy/glama/start.sh`
- **Environment:** none

Deploy, wait for Glama's test run to pass, then make a release from the listing's releases page.
If Glama runs the command from somewhere other than the repo root, `start.sh` still finds the build from its own location.

Optional overrides: `MUSTERD_TEAM`, `MUSTERD_SEAT`, `MUSTERD_PORT`.
