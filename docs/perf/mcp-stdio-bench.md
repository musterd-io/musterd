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

## codex (2026-10-14; falsify: ten runs of the command below, on this entry, with a 1-minute load under 13, put the median `spawn_to_tools_list_ms` outside 201–288, or return a tool count other than 31)

Measured by big-body. The command is the one that workspace's
`.codex/config.toml` launches: `/opt/homebrew/Cellar/node@22/22.23.1/bin/node`,
entry `~/.musterd/runtime/packages/mcp/dist/index.js`, `--surface codex`. Ten
runs. The 1-minute load was 12.84 at the start and 12.05 at the end.

| | spawn → tools/list |
| --- | --- |
| median | 222.4 |
| range | 201.9–287.1 |

31 tools, 19811 bytes, `tools_list_has_ttl` false. One line near the median:

```json
{"entry":"/Users/nick/.musterd/runtime/packages/mcp/dist/index.js","import_ms":70.4,"import_wall_ms":124.2,"surface":"codex","spawn_to_initialize_ms":218.9,"spawn_to_tools_list_ms":223.8,"tools":31,"tools_list_bytes":19811,"tools_list_has_ttl":false}
```

Schema before the first `team_*` call: no. The session's first visible tool
declarations held no `team_*` schemas. Before its first call it listed every
tool through `functions.exec` `ALL_TOOLS`, whose descriptions carry the
schemas, then called `team_inbox_check`. It used no tool-search service. That
is what the model could see, not the host's internal load timing.

## opencode (2026-10-14; falsify: ten runs of the command below, on this entry, with a 1-minute load under 4, put the median `spawn_to_tools_list_ms` outside 193–208, or return a tool count other than 31)

Measured by dreamy. The command is the one that workspace's OpenCode config
launches: `/usr/local/bin/node`, entry
`~/.musterd/runtime/packages/mcp/dist/index.js`, `--surface opencode`. Ten
runs. The 1-minute load was 3.62 at the start and 3.65 at the end.

| | import_ms | spawn → initialize | spawn → tools/list |
| --- | --- | --- | --- |
| median | 76.4 | 191.6 | 196.9 |
| range | 74.9–79.8 | 187.6–202.7 | 193.3–207.8 |

31 tools, 19811 bytes, `tools_list_has_ttl` false. One line near the median:

```json
{"entry":"/Users/swethadhamodharan/.musterd/runtime/packages/mcp/dist/index.js","import_ms":74.9,"import_wall_ms":116.3,"surface":"opencode","spawn_to_initialize_ms":192.3,"spawn_to_tools_list_ms":197.4,"tools":31,"tools_list_bytes":19811,"tools_list_has_ttl":false}
```

Schema before the first `team_*` call: partly. OpenCode runs MCP tools inside
its Code Mode `execute` catalog, and the system prompt showed 7 of the 31
musterd tools (`lane_release`, `team_leave`, `team_memory_read`, `team_next`,
`team_seed_get`, `team_status`, `team_style`). `team_inbox_check` was not one
of them, so the first `execute` block called `search({ namespace: "musterd" })`
before it. `team_next` and `team_status` were already loaded and ran in that
same block.

## What the three show

The spawn itself is not the cost. All three hosts launch the adapter and get
the tool list back in under 350 ms at the median, and the spread follows
machine load. The schema step is where they differ: Grok had `team_*` loaded,
Codex enumerated its tool list first, and OpenCode searched for any tool
outside its 7 shown.
