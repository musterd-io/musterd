<!-- Eval input: six PRs merged to musterd main between 2026-10-10 and 2026-10-13, with the opening of each PR body. -->

#2475 copy(site): every team gets an office; knowledge work in the close (ADR 578)
The three strings from homepage-copy-spec.md §0b, text only: the StreamSection body says every team gets an office; the WhyTalk close says none of it is specific to code, and one lane in six on our own team is writing (counts.sh, a floor); /watch defines "the office" by what a reader recognizes: board, inboxes, memory, record, the room.

#2480 feat(live): the Now card shows stopped goals (inc 1)
A plan whose later increments nobody is building used to vanish from the Now card the moment nothing in it was moving. Now the card has a Stopped list after the goals in motion, absent when nothing is stalled. Hover names the oldest untouched lane; click drills the board into the goal. Increment 2 (the office's own tell) gets its own lane once this is accepted.

#2476 feat(mcp): hot tools load without a schema search on Claude Code
Claude Code defers MCP tools behind ToolSearch by default, so a session's first musterd call cost an extra schema-search turn. Four tools (team_join, team_inbox_check, team_send, team_status) now load upfront. Cost: 3,019 bytes (~750 tokens) of standing context per turn. Cursor has no per-tool loading control, so Cursor is unchanged.

#2474 perf(mcp): serve initialize without waiting on bind()
main() awaited a GET /health before starting the stdio transport, so every harness's initialize waited on that daemon round trip. bind() now runs beside the transport. An unreachable daemon still fails the start with the same error.

#2486 fix(deps): locally patch Expo and Metro alerts
pnpm local patches for the node-forge and braces versions still required by Expo and Metro. Resolved versions are unchanged, so Dependabot may keep listing the alerts.

#2463 fix(telemetry): bundled MCP adapter crashed when an OTLP endpoint was set
Since #2435, every musterd MCP adapter on a machine with an OTLP endpoint configured died before answering initialize ("musterd MCP failed to start: resourceFromAttributes is not a function"); harnesses showed CONNECTION_CLOSED. Fixed.
