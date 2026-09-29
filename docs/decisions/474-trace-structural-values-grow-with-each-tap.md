# 474 — A trace parser tag is pattern-typed, and OpenCode's tools have a namespace

- Status: proposed
- Date: 2026-09-29
- Lane: `01M3NNK27K7BHWHVXBH8TCN5BA` (goal `research-corpus`)
- Builds on: [ADR 453](453-trace-structural-replication.md) §2 (the structural value lists this amends),
  [ADR 445](445-agent-traces-captured-local-first.md) §2 (the version-stamped parsers).

## Context

ADR 453 §2 makes every structural trace field a type that prose cannot fit: closed enums, counts,
flags, a model-id pattern, and a `tool_name` bounded to each harness's namespace. Local ingest, the
sync pusher and the hub all normalize through `packages/protocol/src/traceSync.ts`. An enum value
not on its list, or a tool name outside the harness's namespace, becomes `other`. Local ingest
applies this on write, so the stored row keeps `other` for good.

The lists were measured on 2026-09-26. Four taps and one parser bump have shipped since: `codex@2`,
`cursor@1`, `grok@1`, `opencode@1`, and OpenCode's R1 tool names. None of them were added. Measured
in the dogfood `trace.db` on 2026-09-29:

| harness | `detail.parser` stored | rows  |
| ------- | ---------------------- | ----- |
| codex   | `codex@1`              | 6,077 |
| codex   | `other` (was `codex@2`) | 4,294 |
| cursor  | `other` (was `cursor@1`) | 76  |
| opencode | `other` (was `opencode@1`) | 32 |

Every OpenCode `PostToolUse` row also has `tool_name` `other`, though the plugin sent `bash`,
`read` and `musterd_team_inbox_check`.

## Problem

`report trace` cannot tell a `codex@1` session from a `codex@2` one, so ADR 445's parser-version
falsifiers cannot be checked daemon-side. OpenCode's tool mix is blind. And the fix-by-list recurs:
each new tap or parser bump is a protocol change, and it is missed exactly when nobody remembers
the list exists.

## Decision

1. **`detail.parser` is pattern-typed, not a list.** A value passes when it matches
   `TRACE_PARSER_RE` = `^[a-z][a-z0-9-]{0,31}@[0-9]{1,4}$` (`<harness>@<n>`); anything else becomes
   `other`, as an enum value does. The pattern has no `_`, and every `TOKEN_PREFIXES` credential
   has one, so no credential can match; nor can prose, which has no `@<digits>` suffix.
   `TRACE_PARSERS` is removed. A new parser or version needs no protocol change.
2. **OpenCode gets a tool namespace**: its built-ins, lowercase as its plugin names them (`bash`,
   `read`, `write`, `edit`, `patch`, `multiedit`, `glob`, `grep`, `list`, `todowrite`, `todoread`,
   `webfetch`, `websearch`, `task`, `skill`).
3. **OpenCode MCP tools: only musterd's own server is claimed.** OpenCode spells an MCP tool
   `<server>_<tool>`, so the server boundary cannot be recovered from the name, and a general
   `\w+_\w+` pattern would bound nothing. `musterd_<tool>` (lowercase,
   `TRACE_OPENCODE_MUSTERD_TOOL_RE`) passes on the `opencode` harness only; every other server's
   tool is `other`. musterd's own tools are the ones the research reads.
4. **Tool namespaces stay lists**, grown in the change that starts emitting a new name (ADR 453
   §2's existing rule). A tool name is the field most able to carry a free identifier, so it keeps
   the closed form.

## Consequences

- Rows ingested before the daemon runs this build keep `other`; there is no backfill. ADR 445
  records the date.
- **Version skew, hub first.** The hub rejects a whole batch that fails its schema (ADR 453 §3), and
  the pusher holds its cursor on a non-2xx. A joiner on this build pushing `codex@2` or an OpenCode
  tool name to a hub on an older build is refused until the hub updates. Update the hub first. No
  hub is enrolled on the dogfood machine on 2026-09-29, so nothing is exposed today; the risk
  becomes real with the first hosted team (goal `cloud`).
- The grok namespace is unchanged. Its tool names are not re-measured here.

## Observability & Evaluation

- **Traces:** `trace.db` is the evidence. After the daemon runs this build, new R2 rows carry their real parser tag and OpenCode R1 rows carry their real tool name. Read: `SELECT harness, json_extract(detail,'$.parser'), count(*) FROM trace_events WHERE received_at > <deploy> GROUP BY 1,2`.
- **Eval:** `traceSync.test.ts` pins every shipped parser tag, the prose and credential cases, OpenCode's built-ins and `musterd_*` tools. Falsifier: a `usage` row ingested after the daemon runs this build, from a `codex@2`, `cursor@1`, `grok@1` or `opencode@1` tail, whose `detail.parser` reads `other`; or an OpenCode `PostToolUse` for `bash`, `read` or a `musterd_*` tool whose `tool_name` reads `other`.
- **Experiment:** none. The table in Context is the measurement; the fix changes a normalization, not a behaviour to compare.
