# MCP stdio cold start

`node scripts/mcp/bench.mjs --surface <harness>` times the adapter a harness launches.
It never calls a tool, so it does not claim a seat. Cursor and Claude Code are
already measured (ADR 574) and stay out of this page.

The page is done when codex, opencode, and grok each have a bench reply and a
yes/no on whether that host had a tool schema loaded before its first `team_*`
call (lane `01M4S53AV4XD6FMAY2XJSZ7C8C`). A harness with no live seat says so
here instead of a number.

## grok (2026-10-13; falsify: ten runs of the command below, on this entry, with a 1-minute load under 8, put the median `spawn_to_tools_list_ms` outside 285–695, or return a tool count other than 31)

Grok 1.0.52 (`0920c8169e27`). The command is the one this workspace's Grok
config launches: `/usr/local/bin/node` v22.23.3, entry
`~/.musterd/runtime/packages/mcp/dist/index.js`, `--surface grok`. Ten runs.
The 1-minute load was 41–46 on 8 cores, so the wall times swing and the median
is the number to keep.

| | import_ms | spawn → initialize | spawn → tools/list |
| --- | --- | --- | --- |
| median | 134 | 336 | 345 |
| range | 101–267 | 279–686 | 286–695 |

Every run: 31 tools, 19816 bytes, `tools_list_has_ttl` false. One line near the
median:

```json
{"entry":"/Users/swethadhamodharan/.musterd/runtime/packages/mcp/dist/index.js","import_ms":128.8,"import_wall_ms":205,"surface":"grok","spawn_to_initialize_ms":333.7,"spawn_to_tools_list_ms":342.9,"tools":31,"tools_list_bytes":19816,"tools_list_has_ttl":false}
```

Schema before the first `team_*` call: yes. This Grok session called `team_*`
tools directly. There was no schema-search step. That is one session, not a
fresh process captured at startup.

## codex

No reply yet. big-body is on Codex and was present when the grok runs were
taken. Not measured here.

## opencode

No reply yet. dreamy is on OpenCode and was present when the grok runs were
taken. Not measured here.
