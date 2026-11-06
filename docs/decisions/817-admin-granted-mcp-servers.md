# 817 — Admin-granted MCP server definitions

- Status: accepted
- Date: 2026-11-05

## Context

ADR 794 put seat tool grants in team policy. Plugins, skills, and the names of human-layer MCP
servers are lists an admin writes. A toolkit file can still name an MCP server for a harness to
run. That file lives in the seat's workspace. The seat and the file share one trust domain. ADR 794
already treated a local toolkit as unaudited, because the seat it governs can edit it, and moved
plugins and skills to policy for that reason. The command or URL a harness runs stayed with the
toolkit.

## Problem

A check that runs inside the seat's workspace cannot decide which command the harness runs. The
seat can change the toolkit file, and it can change anything else in that workspace the check
consults. The authority for that command has to sit somewhere the seat does not write. Team policy
is that place: only an admin human writes it, and the write is audited.

## Decision

1. `seat_tools` gains `servers`, a map from server name to a definition. A definition is exactly
   one transport, `command` (stdio) or `url` (remote HTTP), plus `args` (default `[]`) and `env`
   (default `{}`). The schema is `SeatToolServerSchema` on `SeatToolsPolicySchema`. An absent map
   reads as `{}`.
2. A toolkit may propose an MCP server. Provisioning writes the proposal only when it equals
   `seat_tools.servers[name]`, or equals a built-in server definition shipped in the CLI. Equality
   is the transport, the args in order, and the env pairs. The order of env keys does not matter.
3. No matching grant and no matching built-in means the proposal is not provisioned. A failed or
   missing read of the grants is the same as an empty map. The read is `GET /seat-tools`. The CLI
   does not consult a file in the workspace for this map. Built-in definitions still provision,
   because they are the package, not the workspace.
4. `mcp_servers` on a grant set stays a list of names of servers in the human's layer. It does not
   define a command.
5. Only an admin human writes the map, through `POST /policy`, the same gate ADR 794 set for the
   other grants.

This supersedes ADR 794's line that defining a new server stays in repo-committed toolkits.

## Consequences

- A toolkit that names a server the built-ins do not, and that no admin has granted, no longer
  results in that server being provisioned. Permission defaults on the toolkit are unchanged.
- A workspace copy of a built-in definition still provisions. A copy that changes the command, the
  args, or the env does not, unless an admin grants that definition.
- A team that wants a custom server grants it with `musterd team policy --seat-tools`. The
  confirmation line counts the server definitions in the doc. The next provision leaves an
  ungranted proposal unprovisioned and names it.
- The product floor and the `mcp_servers` name list are unchanged.

## Observability & Evaluation

- Traces: a grant write is the existing `policy.change` audit row. A proposal that is not
  provisioned is named, by server name, on the equip and init lines (`no matching grant`). The
  command and the env are not printed.
- Eval: n/a — the regression tests are the check. This is not an agent-behavior change.
- Experiment: n/a — no rollout choice. The grant is the rule, not a dial.
