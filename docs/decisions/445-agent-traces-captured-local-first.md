# 445 — Agent traces are captured local-first: every harness action, on the machine that made it

- Status: accepted — 2026-09-24, by nick in session ("approved"), on the narrowed text (scope
  chosen with nick: full fidelity, local-first; narrowed the same day on nick's acceptance of three
  changes — a scope not a reversal, content opt-in with a credential scrub, a separate trace
  database — see §1, §3, §4; R3 corrected for ADR 286 in #1697 before this flip). Increment 0
  landed the same day (#1699) and its falsifier held — see Consequences.
- Date: 2026-09-24
- Lane: `01M3AJQXXJ2B6NN43E11A41AKX` (goal `research-corpus`)
- Scopes: `docs/design/observability.md` §7's first non-goal. The non-goal **stands as a product
  boundary** — musterd does not ship agent-internals observability and does not replicate a
  vendor's trace store. What this ADR adds sits under [ADR 082](082-instrument-by-default-telemetry.md)'s
  existing line instead: the daemons _we_ run capture their own seats' harness activity as research
  substrate, on the producing machine, off by default for the product.
- Builds on: [ADR 015](015-otel-layer1-server.md) / [ADR 082](082-instrument-by-default-telemetry.md)
  (off-by-default, no phone-home, instrument-by-default for dogfood daemons),
  [ADR 089](089-telemetry-l2-client-sdk.md) (the adapter/CLI SDK this ADR switches on),
  [ADR 144](144-mcp-tool-surface-measure-then-craft.md) (the one per-tool-call telemetry that exists,
  for musterd's own tools), [ADR 150](150-structural-inducement-pretooluse-gates.md) /
  [ADR 163](163-actor-attestation-tool-boundary.md) (the PreToolUse hook rail this ADR widens),
  [ADR 184](184-dataset-consent-and-redaction.md) (emitted ≠ published — the line this ADR keeps),
  [ADR 251](251-native-backend-musterd-as-its-own-harness.md) §7 (daemon-owned transcript capture,
  today native-only), [ADR 371](371-the-record-kind-and-the-rest-of-the-ledger.md) (the `record`
  sync kind that decides what replicates), [ADR 194](194-flywheel-practice-not-batond.md) (emit in
  musterd, compare in the research practice).
- Audit: [observability — current state](../wiki/observability-current-state.md), 2026-09-24.

## Context

nick's ask on 2026-09-24: _"We need to be able to fully capture e2e agent traces/runs that include
every single action (commands, reasoning, tool calls, code execution, MCP tool calls, hooks etc,
outputs, turns etc)."_ The audit behind this ADR found that the plan never intended that, and the
build never did it:

- **The plan drew the line at coordination.** `observability.md` §7: "Observability of agent
  internals (reasoning steps, LLM calls) — that's the existing market's job; we link to it, we don't
  replicate it." Layer 1 instruments musterd, Layer 2 derives insight from the act log. The only
  intended bridge to what an agent did inside its harness was the ADR 011 `traceparent` link — a
  join key into a backend the operator brings, which on the dogfood box nobody has brought.
- **Coordination capture is complete and running.** Acts, lanes, audit verbs, presence, attested
  model, musterd-tool aggregates (`tool_call_stats`, 25,077 calls since 2026-07-15), wake cost —
  all recorded; the envelope span exports live to the local sink.
- **Harness capture is nil.** Every harness on the box already runs a musterd hook on every tool
  call (ADR 150's gate, the interrupt probe, Codex/Cursor/Grok observers), and those hooks forward
  nothing about the call unless it matches an enforcement class — then a class name and a sha256
  fingerprint. No hook forwards a tool name, input, output, duration, prompt, response, turn or
  subagent boundary as data. The session's `transcript_path` is written to the local binding and
  read for mtime, size and a model id — never for content.
- **The raw material exists, unread.** Claude Code persists `thinking`, `tool_use`, `tool_result`
  and per-message `usage` to `~/.claude/projects` (781 MB here); Codex persists `reasoning`,
  `custom_tool_call`/`_output` and `token_count` to `~/.codex/sessions` (910 MB). Nothing musterd
  owns reads either. Claude Code's own OTel exporter can emit prompts, responses, tool results and
  cost with opt-in content flags, never thinking; it is not enabled.
- **The one full-fidelity store is the wrong shape.** ADR 251 §7's `wake_turns.transcript_json`
  captures every turn — for the native backend only (16 rows). The seats doing the work are on
  Claude Code, Codex, Cursor and Grok.
- **The client SDK is dormant.** ADR 089's `musterd.tool.call` / `musterd.cli.command` spans never
  export because the adapter and CLI processes are launched without `OTEL_EXPORTER_OTLP_*`; the
  ADR 011 cross-agent trace has therefore a measured link rate of 0%, as at its baseline.

Why the non-goal needs a scope, not a repeal. It was written for a product that sits _between_
single-agent observability vendors; that positioning is unchanged (§3) and stays the product
boundary. But the research corpus (ADR 056's produce side) and every cookoff/wasted-work number so
far were reconstructed from harness transcripts by hand — "a non-Claude agent's is unrecoverable"
(ADR 082) — and the dataset musterd can uniquely publish is _coordination acts joined to what each
seat actually did_. Linking to a vendor backend nobody runs is not a join. The join has to be made
on the machine where both halves exist, by the daemons we run, as substrate — which is a research
scope under ADR 082, not a change to what the product ships.

## Problem

Decide, in one place, (1) whether musterd captures agent internals at all, (2) through which rails,
(3) where the capture lives and what may leave the machine, so that increments can be built lane by
lane without re-deriving the posture, and so that ADR 184's publication line is not eroded by the
capture it now sits in front of.

## Decision

### 1. Capture is a research substrate, local-first; §7 stays a product boundary

musterd captures a seat's harness activity — prompts, tool calls with inputs and outputs, reasoning
where the harness persists it, token usage, hook outcomes, turn and subagent boundaries — into a
daemon-owned store on the machine that produced it. This is **scoped under ADR 082**: it is what the
dogfood daemons do to their own seats so the research corpus stops being reconstructed by hand. It
is not a product feature and `observability.md` §7 is not reversed: musterd does not build a spans
database, an LLM-call dashboard or an eval platform for _other people's_ traces, does not ship
agent internals anywhere by default, and emission to an operator's OTLP backend stays "integrate,
don't build" (§3). §7 gains a dated scope note pointing here; its text stands.

### 2. Three rails, in priority order

- **R1 — the hook tap (primary).** The hooks every harness already runs forward a structured
  `TraceEvent` for every hook the harness fires: `SessionStart`/`SessionEnd`, `UserPromptSubmit`,
  `PreToolUse`/`PostToolUse`/`PostToolUseFailure`, `Stop`, `SubagentStart`/`SubagentStop`,
  `PreCompact`, and their Codex/Cursor/Grok equivalents. Fields: harness, session digest (ADR 131
  §5 — never the raw id), seat, `hook_event`, `tool_name`, `tool_use_id`, `agent_id`/`parent_agent_id`,
  `duration_ms`, outcome, and a **content** part (`tool_input`, `tool_response`, prompt,
  `last_assistant_message`). The tap is best-effort and fail-open: it never blocks or slows the tool
  call it observes (batched, posted asynchronously, dropped on daemon unreachability with a local
  counter). musterd's own hooks record their own outcome (hook, exit code, duration) as a
  `TraceEvent` too — the harness's hook spans are beta-gated and Claude-only.
- **R2 — the transcript tail (the reasoning rail).** The host tails `binding.session.transcript_path`
  locally and emits `reasoning`, `assistant_text` and `usage` events per turn, keyed to the same
  session digest and joined to R1 by `tool_use_id`/turn. The parser is per-harness, version-stamped
  and tolerant: an unrecognised record is emitted as `{kind:'unknown', bytes}`, never dropped
  silently, and a parse failure downgrades the session to structural-only with an audit row. The
  harness's on-disk format is not a contract (Anthropic says so) and this ADR does not make it one.
- **R3 — harness-native OTel, and the dormant SDK switched on.** For dogfood seats (ADR 082's
  scope), the adapter and the CLI resolve their OTLP endpoint from **machine-local config** when
  the standard env is absent: `~/.musterd/config.json` `telemetry.otlp_endpoint`, written by
  `musterd service install --otlp-endpoint` beside the daemon plist. It is **not** written into the
  MCP registration env — [ADR 286](286-launcher-surface-convergence.md) §1 fixes that env to exactly
  `MUSTERD_LAUNCH_SURFACE`, and this ADR keeps it so. `OTEL_SDK_DISABLED=true` still wins, and an
  explicit `OTEL_EXPORTER_OTLP_*` env still wins over the file, so ADR 015's "operator points us at
  an endpoint" posture is unchanged in kind: the pointer may live in a file the operator wrote.
  With that, ADR 089's `musterd.tool.call` / `musterd.cli.command` spans and the ADR 011 link fire.
  For Claude Code seats the onboarding reconciler (ADR 282) may additionally carry a settings `env`
  fragment (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP exporters to the same endpoint, content flags
  off) — dogfood-only, declined like any other fragment. R3 is a link and a cost/token
  cross-check, not a store.

### 3. One table in its own database, two body classes, and what leaves the machine

- A per-event table `trace_events` (team, seat, session digest, monotonic seq, ts, harness, kind,
  structural columns) with the content part in a separate nullable column. Per-call rows, not
  aggregates — `tool_call_stats` stays as the hourly view for musterd's own tools.
- **A separate database file**, `trace.db` beside `musterd.db` (same directory, same
  `better-sqlite3`, its own migration ladder). Per-call rows with up to 256 KiB of content each will
  outgrow the coordination store within weeks, and the daemon wedged twice on 2026-09-24 in
  synchronous SQLite work on `musterd.db`; the trace store must not add to that file's size, lock
  contention or backup weight. `corpus:snapshot` captures both files; nothing joins across them at
  write time — the join key (session digest + `tool_use_id`) is carried in both.
- **Structural** columns follow ADR 184 §2's definition (names, ids, kinds, timings, counts,
  fingerprints) and replicate under ADR 371's `record` kind and export under `dataset:export` as
  today. _(Amended 2026-09-26: the `record`-kind replication clause is superseded by
  [ADR 453](453-trace-structural-replication.md). See the Consequences note.)_ **Content** columns (inputs, outputs, prompts, responses, reasoning) never replicate, never
  export, and never cross the wire off-machine without ADR 184 §3 consent recorded per author. They
  are readable through the daemon by the seat that produced them and by admins (ADR 128's
  recipient-scoping applied to a seat's own trace).
- **Content capture is opt-in per team; structural is the default.** A team-level setting
  `trace.content` (default `off`) decides whether the content column is written at all; `revive` sets
  it `on`. With it off, R1 still records every event's structural columns, so the coverage eval in
  §Observability holds either way.
- **Credentials are scrubbed at the hook, before anything is stored.** Tool inputs and outputs can
  carry secrets verbatim (a `cat` of a binding, a token in a curl header). The tap replaces every
  token matching the protocol's `TOKEN_PREFIXES` shapes (`mskey_`, `msgr_`, `mscr_`, `msac_`,
  `msls_`, and any later prefix registered there) and the generic bearer/API-key shapes
  (`Authorization: Bearer …`, `sk-…`, `ghp_…`, 32+-char hex/base64 runs after `token=`/`key=`)
  with `<redacted:kind>` and records `redactions: n` on the row. This is a **credential** scrub
  only — hard rule 5 ("never log secrets") applied to a new log — not a PII scrubber, which ADR 184
  §2 rejects as false safety; prose stays prose.
- Content is bounded: `WAKE_TURN_TRANSCRIPT_MAX_BYTES` (256 KiB) per event, truncation recorded on
  the row; content older than 30 days is pruned unless `corpus:snapshot` captured it; structural
  rows keep the messages table's lifetime.
- Bash commands in content are stored as text (after the scrub) — the sha256 fingerprint stays on
  the ADR 150 gate rows, which are the enforcement record and unchanged.

### 4. Posture

Off by default for the product (ADR 015/082: no OTLP endpoint → no export; no `trace` config →
no tap); structural tap on by default for the daemons we run; content only where `trace.content`
is `on`. A seat can see that it is being traced and how deep: `musterd status` and `team_status`
say `traced: structural` or `traced: structural+content` when the tap is on.

### 5. What this does not decide

The `/live` timeline and `musterd report` views over `trace_events` (increment 4 — **human-gated**:
views are where a research substrate starts to look like the product §7 says we do not build, so
that increment opens only on nick's explicit word, not as a natural next step);
Cursor/Grok/OpenCode transcript parsers (R2 ships Claude Code and Codex first); any change to
ADR 184's publication gate; a spans backend.

### 6. Increments

0. R3: adapter/CLI resolve the OTLP endpoint from `~/.musterd/config.json` when the env is absent
   (`service install --otlp-endpoint` writes both plist and file); Claude Code OTel `env` fragment
   into the existing sink. No protocol schema change. Falsifier: `musterd.tool.call` and
   `claude_code.*` records in the sink after an adapter restart.
1. R1 in two halves. **1a structural**: `TraceEvent` protocol schema, `trace.db` + `trace_events`
   migration, `POST /teams/:slug/trace/events`, the Claude Code hook payload, then Codex/Cursor/Grok
   hook adapters — no content column written. **1b content**: the credential scrub (with its own
   test corpus of every `TOKEN_PREFIXES` shape and the generic shapes), the `trace.content` team
   setting, and the content column. 1b does not ship without the scrub tests green.
2. R2 transcript tail for Claude Code and Codex; join on `tool_use_id`; `musterd trace show
   <session>` renders one session end to end.
3. Replication/export wiring: structural columns into the `record` sync kind and `dataset:export`;
   content pruning; `corpus:snapshot` includes `trace_events`.
4. Views (human-gated, §5): `/live` per-seat timeline; `musterd report trace` (coverage, cost per
   lane, tool mix).

## Consequences

- _Amended 2026-09-29 by [ADR 475](475-cloud-hosted-teams-postgres.md) decision 9 (proposed):_
  on a **hosted** team the seat's authority is not on its machine, so captured content may travel
  from the seat to **the team's server of record** — and only there — under per-author, opt-in,
  recorded consent. §3's "never cross the wire off-machine" and build note (2)'s "content goes
  only to a loopback daemon" read "only to the team's own authority" for a hosted team; a
  self-hosted daemon is unchanged. ADR 184's emitted ≠ published line is kept. ADR 475 also
  widens this ADR's scope from a dogfood substrate to a capability any hosted team may enable,
  with the retention and access rules that make that defensible recorded there.
- `observability.md` §7 keeps its non-goal and gains a dated scope note pointing here (the first
  cut of this ADR, merged in #1691, struck the line as "reversed"; nick declined that framing the
  same day and the strike is undone); §4's "CLI and MCP adapter only get error/diagnostic logging"
  line, stale since ADR 089, is corrected alongside.
- `07-conventions.md`'s "agent-turn detail" (the ADR 052 section) finally has a referent: the
  `TraceEvent` kinds of §2. ADR 184's table row "spans — prompt by hash + version — enforced" gets a
  dated note: nothing emits a prompt hash today; R1/R2 content is governed by §3 above instead.
- `docs/dogfood-telemetry.md`'s "export leftover" (2026-08-14) is corrected: the plist carries the
  endpoint and the sink is live; what is dormant is the adapter/CLI side (§2 R3).
- The research corpus gains the half it has reconstructed by hand since finding 001: per-seat
  action, cost and reasoning joined to coordination acts, for every harness, not only Claude.
- Risk: content capture makes a daemon-owned store more sensitive than the act log already is
  (ADR 184's `messages.body` is verbatim prose; tool output can be a file of secrets). The
  mitigations are §3's, in order of strength: content is off unless a team turns it on; credentials
  are scrubbed before storage; the column is bounded, pruned, and structurally barred from
  replication and export; and it lives in a file the coordination store never opens. What remains
  is prose and code in `trace.db` on the operator's own disk, which is the same exposure as the
  harness's transcript directory today.
- **2026-09-24 — increment 0 landed (#1699, `e1284b4f`).** `@musterd/telemetry` reads
  `telemetry.otlp_endpoint` from the machine config when no `OTEL_*` env is set; `service install
  --otlp-endpoint` writes it; the dev sink takes `/v1/logs`. Falsifier on the dogfood box, once the
  daemon checkout had auto-refreshed: `musterd.cli.command` spans in the sink went 2 → 5 across
  `status` / `whoami` / `session`. One trap surfaced on the way: a CLI build older than a config key
  erases it on its next write (`readConfigFromDisk` whitelists keys), so a new key is stable only
  after every CLI touching the machine config is at or past the build that knows it — recorded as
  a team insight, fix candidate open.
- **2026-09-25 — increment 1a landed for Claude Code** (lane `01M3CXMVWF4E42WXTW323DHEWG`): `TraceEvent`
  schema (structural only — no content field exists in the schema), `trace.db` with its own ladder,
  `POST /teams/:slug/trace/events` (seat credential, leaseless, presence-neutral), the
  `musterd.trace.ingest` counter, and the Claude Code tap. Two things decided in the build: (1) the
  daemon assigns `seq` — a hook is a one-shot process with no counter to share; (2) the tap rides
  the processes the hooks already spawn (gate → PreToolUse, interrupt probe → PostToolUse, capture
  → SessionStart/End) and only the six events with no musterd hook get a new `musterd trace hook`
  registration, which is what keeps the per-call cost at "what the gate costs now". The 1a tail —
  Codex/Cursor/Grok hook adapters and musterd's own `HookOutcome` rows — is open; the
  `traced: structural` status line (§4) lands with it. The pre-#1699 config-erasure trap is fixed
  (#1706: unknown top-level keys pass through).
- **2026-09-25 — the 1a tail landed** (lane `01M3D1S9CE6K1JXEKS4FCBAXEC`). Codex taps `SessionStart` /
  `SessionEnd` / `PostToolUse` from `codex-hook`; Cursor taps from `session observe` (its camelCase
  events map onto this column's spelling; `postToolUse`, `afterShellExecution` and `afterMCPExecution`
  all record as `PostToolUse`, with the source name kept in `detail.hook_event` so a reader can
  de-duplicate an IDE call that fired two of them). The gate now infers the harness from the payload
  when its env names none, which fixes a mis-attribution: Grok's `PreToolUse` rows had been recorded
  as `claude-code`. `HookOutcome` rows ship for the gate (`decision`, `outcome: denied` on a deny) and
  for each harness's interrupt probe (`raised`, `deaf`). `duration_ms` is the hook process's whole
  life, node boot included, because that is what the tool call waited for. Each hook sends its
  observed event and its outcome in ONE post, and the gate posts after its decision is on stdout
  (it used to fire mid-decision). `musterd status` and `team_status` print `traced: structural` when
  the tap would record: no kill switch, an agent key and a seat credential, and a daemon whose
  `/health` names `trace_schema`. **Open, and recorded rather than built:** Grok's `Stop` hook runs
  the interrupt check with stdin ignored, and its PreToolUse probe carries no `--hook` flag, so
  neither is tapped. Closing that means rewriting the Grok hook lines, which needs a `FEATURE_EPOCH`
  bump, so it waits for the next Grok hook change rather than forcing one. Falsifier on the dogfood
  box, once autorefresh has run: `SELECT harness, kind, count(*) FROM trace_events GROUP BY 1, 2`
  shows `HookOutcome` rows beside `PreToolUse` / `PostToolUse` from a Claude Code seat.
- **2026-09-25 — increment 1b landed** (lane `01M3D3FZ5Q6FZE7MJS0JBC71H3`). The protocol gains
  `TraceContentSchema` (an optional `content` part on `TraceEvent`: prompt / tool input / tool
  response / error / assistant, bounded together to 256 KiB, with `redactions` and `truncated`), the
  `trace` policy block (`content: off|on`, default `off`; `musterd team policy --trace-content`), and
  `traceScrub.ts`. The daemon writes the content column only under `trace.content: on`, after its
  own second scrub pass; with the setting off, a content part that arrives anyway is dropped. Three
  things were decided in the build:
  (1) **The tap learns the policy from the ingest reply.** `202 {accepted, content}` carries the mode,
  the tap caches it in `.musterd/trace-policy.json`, and content flows from the next hook on. That
  costs no extra round trip, and a seat that has never heard `on` sends nothing.
  (2) **Content goes only to a loopback daemon.** A binding can name a remote server; §3's
  "never cross the wire off-machine" is enforced at the tap, not assumed.
  (3) **Two scrub findings from the corpus.** A token after a JSON-escaped newline (`\nmskey_…`) or a
  URL-encoded quote (`%22mskey_…`) slipped past a plain word-boundary test. So the start boundary
  now accepts escapes, and structured values are scrubbed leaf by leaf before they are stringified.
  Separately, musterd prefixes carry no start boundary at all, because a miss stores a secret while
  a false hit costs one identifier its tail. `traced: structural+content` shows where the hooks send
  content. Pruning at 30 days stays in increment 3 with the rest of the content lifecycle. Falsifier
  on the dogfood box, after `musterd team policy --trace-content on` on `revive`: rows with non-null
  `content` appear from the second hook of a session, and
  `SELECT count(*) FROM trace_events WHERE content LIKE '%mskey\_%' ESCAPE '\'` returns 0.
- **2026-09-25 — increment 2 landed** (lane `01M3D6H2C0652SDJBVFH1NRBRM`). Rail R2 for Claude Code
  and Codex. The protocol gains the four transcript kinds (`reasoning`, `assistant_text`, `usage`,
  `unknown` — lowercase, so the two rails stay apart in one column) and a `reasoning` content field.
  Decided in the build: **the tail is the hook processes that already exist** — Claude Code's `Stop`
  (per turn) and `SessionEnd` capture, Codex's `post-tool-use` (its rollout path rides the binding
  from SessionStart) and `end` — reading the transcript's delta from an offset cursor in
  `.musterd/trace-tail.json`; no long-lived tailer, and the per-turn cost is one bounded file read
  plus the same fire-and-forget POST the tap already pays. Parsers are version-stamped
  (`claude-code@1`, `codex@1`) and grouped to the harness's real shape: Claude splits one API
  message across jsonl lines (grouped by `message.id` — one `usage` per message, joined to R1 by the
  message's first `tool_use` id), Codex writes reasoning and its tool call as separate items (a
  reasoning item binds to the NEXT `call_id`; `token_usage_record` is the usage source and
  `token_count` a recognised skip, or every turn would count twice). Reasoning is largely encrypted
  at rest in both harnesses — what R2 stores is the summary/plaintext the harness kept, sizes
  either way. A parse failure or truncated file downgrades the session (§2): cursor flag, one
  `unknown {downgraded}` event, and a `trace.downgraded` audit row written by the ingest route.
  `musterd trace show <session|digest>` renders a session end to end over the new
  `GET /teams/:slug/trace/sessions/:digest` (ADR 128 scoping: own seat or admin; anything else
  reads empty, indistinguishable from absent). R2 content passes the same three gates as R1's
  (policy `on`, loopback daemon, scrub-then-cut). Also fixed here: `.musterd/trace-policy.json` and
  the new tail cursor are gitignored — the policy cache had been dirtying every traced seat's
  Workspace and stamping `-dirty` builds (izzo's finding). Falsifier on the dogfood box, once
  autorefresh has run and one turn has ended: `SELECT kind, count(*) FROM trace_events WHERE kind IN
  ('reasoning','assistant_text','usage') GROUP BY 1` is non-empty, and `musterd trace show` on this
  session interleaves both rails.
- **2026-09-25 — increment 3 split; 3a landed** (lane `01M3DG4YK81328EBF9J10SS7R1`). Before the build,
  §6's increment 3 was measured against §3's own reason for a separate file. The dogfood hub took
  5,834 trace rows in 5.24 h (about 26.7k a day), each with about 290 B of structural columns. As one ADR
  371 `record` event per row, that is about 15 MB a day per node in `musterd.db` (the `sync_log`
  payload plus the `audit` detail). The whole `sync_log` to that date was 59 MB. So replication is
  the growth §3 moved trace.db out of the coordination store to avoid, and nick split it off
  (2026-09-25). **3b** (lane `01M3DG52YVZ90GBGD2QJGXAX49`) replicates structural rows, and it takes a
  new ADR before any build. The options are coalesced `record` events, or a trace-only push to the
  hub's `trace.db` that stays out of `sync_log`/`audit`, which would supersede §3's mechanism. **3a**
  is the local lifecycle, and it ships three decisions:
  (1) **"Pruned unless `corpus:snapshot` captured it" means "never before a snapshot holds it."**
  After `corpus:snapshot` captures `trace.db`, it stamps `schema_meta.content_captured_through` in
  the live store: the highest `received_at` in the captured image. The stamp is monotonic and lands
  only after the manifest is on disk. On a machine that carries that watermark, the daemon's hourly
  prune nulls content only when it is both past 30 days AND strictly below the watermark. A machine
  that never archived gets the plain 30-day bound. The prune keeps every structural column and
  stamps `content_pruned_at` (trace ladder v2), so `trace show` can say "content pruned" rather than
  implying content was never captured. It runs in 2,000-row transactions over a partial index; a
  full prune of the dogfood store's 2,269 content rows took 7.8 ms.
  (2) **`musterd status` reports the size** as `traced: … · trace.db <n> MiB`, from a new
  `/health` field `trace_db_bytes` (file + WAL; absent for `:memory:`).
  (3) **`dataset:export --trace-db <snapshot>`** writes `trace_events.jsonl`. It SELECTs the
  structural columns by name (content, redactions, truncation and prune time are never read),
  keeps detail keys on an allowlist of scalars, and HMACs seats and the harness's opaque ids
  (session digest, `tool_use_id`, subagent ids) with the release salt. R1↔R2 still join inside one
  release, and releases stay unlinkable to each other. The live `~/.musterd/trace.db` is refused
  without `--from-live`, as the live coordination DB is. Falsifier on the dogfood box, once
  autorefresh has run: `musterd status` from a traced seat prints the size, and after
  `pnpm corpus:snapshot`,
  `sqlite3 ~/.musterd/trace.db "select value from schema_meta where key='content_captured_through'"`
  is non-empty.
- **2026-09-25 — increment 3b has a proposed channel:** [ADR 453](453-trace-structural-replication.md)
  (proposed, lane `01M3DG52YVZ90GBGD2QJGXAX49`). Structural rows would travel joiner → hub on a
  dedicated `POST /teams/:slug/sync/trace`, from `trace.db` into the hub's `trace.db`. It is
  structural-only by schema, bound to the seats resident on the pushing node, and never touches
  `sync_log` or `audit`. That would replace §3's "replicate under ADR 371's `record` kind" clause
  and nothing else in §3. **Accepted 2026-09-26**: that clause is superseded by ADR 453; nothing
  replicates until its increment 2 lands.
- **2026-09-26 — increment 4 opened on nick's word; the report half landed** (lane
  `01M3FDM0HTR4AFBSRDSHYCHP94`). `musterd report trace [--days N]` over a new
  `GET /teams/:slug/report/trace`: the §Observability coverage eval, computable at last (R1
  `PostToolUse` ÷ R2 `usage.tool_uses`, per harness, with how many sessions carry an R2 rail); the
  tool mix; and tokens per lane, where each `usage` row goes to its seat's most recently claimed lane
  open at the row's `ts`, and a row matching no lane is shown as `unattributed` rather than folded
  in. Structural columns only; ADR 128 scoping resolved at the route (admin: every seat; else own).
  The `/live` per-seat timeline is the second half, lane 01M3FEB12R870FRSYJH0TXD34V, landed the
  same day: a `trace` expander on every roster row reads `GET /trace/seats/:name` (newest 50,
  structural columns only — the store read never selects content) into a lazy chunk, so /live's
  eager graph pays one button per row. The first run of the falsifier below read **124%** coverage
  on `revive` (8 sessions, 2 with R2): the ratio counted every session's hook calls over only the
  R2-bearing sessions' transcript calls. Fixed the same day (lane `01M3FQ75PG4ZA2ZMQ0N2YJZTF8`): the
  numerator is now `post_tool_use_r2`, hook calls inside sessions that carry both rails, and the
  all-sessions count stays on the row as its own fact. Falsifier on the dogfood box: `musterd report trace` from an admin seat prints a non-null
  coverage for `claude-code` and at least one lane with turns.
- **2026-09-28 — the §Observability experiment ran once, on increment 4b** (lane
  `01M3MG7BXY853JC4593APH3692`, [finding 012](../research/012-trace-e2e-check-one-lane.md)). The
  coordination-token ratio rebuilt from structural columns alone read 0.4197%, against 0.4159% from a
  hand read of the transcript: 0.9% apart, so that half passes. The wasted-work half cannot pass as
  written. 13 of the 15 file-writing calls in the build went through Bash rather than `Edit`/`Write`,
  so the tool column does not see most of what was produced. Waste needs a git-side join per lane
  (branch commits against the squash diff), which is open for nick to decide. Claim-window attribution
  in `report trace` also over-counts a lane's build cost: 4b's window carries 4a's closeout and about
  85 minutes after the merge. Falsifier for the pass: a second lane, on another harness, whose two
  sides differ by more than 5%.
- **2026-09-28 — the wasted-work half moves to git** ([ADR 462](462-lane-wasted-work-from-git.md),
  proposed). Per-lane wasted work is ADR 123's predicates over `main` and the remote's PR heads,
  joined to lanes by PR number. It is not rebuilt from `trace_events`. Increment 4b reads 439 authored
  lines and 0 wasted from its claim.
- **2026-09-28 — cost per lane is bounded at the merge** (lane `01M3MMKPWB501MVVFQMJ66P70P`). The
  window was claim → `resolved_at`, so a landed lane stayed open for as long as its acceptor took
  and was charged with the seat's next work — the "85 minutes after the merge" above. The window is
  now claim → merge, the same as ADR 462's. The lane row carries no merge time, so the lane's latest
  `lane.ready_for_review` row stands in for it (a submit follows its merge). That bound applies only
  to a lane that is awaiting acceptance or closed. A rejected lane is back in work, and its old
  submit ends nothing. Usage after the submit and before the next claim now reads `unattributed`.
  Falsifier: a submitted lane whose `report trace` turns still include rows stamped after its submit.
- **2026-09-28 — Grok's two untapped hooks are tapped** (lane `01M3MG7EAMMH9Q2WYE3KPT0AS0`), closing
  the 2026-09-25 open item. The Grok PreToolUse interrupt probe and the Stop doorbell now run
  `musterd inbox --interrupt-check --hook grok`, and the Stop script hands the probe the payload it
  read, where before it spawned the probe with stdin ignored. `FEATURE_EPOCH` is 25, so an older
  checkout cannot rewrite the lines back. One row per call: the probe has no matcher, so on Grok it
  records every `PreToolUse`, and the gate (write tools only) posts only its `HookOutcome`. The gate
  keeps the observed event on Claude Code, where the probe records `PostToolUse`. The probe also
  passes `rail=grok` to the daemon, so Grok's `interrupt.raised` audit rows name their rail (ADR 423).
  Falsifier: a Grok seat's session with `HookOutcome` rows from `interrupt` and `gate`, and
  `PreToolUse` rows for read tools as well as write tools.
- **2026-09-28 — R2 reaches Grok and Cursor** (lane `01M3MGQ93WW9WFQ6MN79EXXCQY`). `grok@1` reads
  `updates.jsonl`, not `chat_history.jsonl`, because only `updates.jsonl` has timestamps and usage.
  It emits coalesced reasoning and assistant chunks, and one `usage` per `turn_completed` with its
  `tool_call` count. `cursor@1` reads the agent transcript, which has no timestamps, tokens, or
  reasoning. It emits assistant text and one `usage` per turn that carries only `tool_uses`, so a
  Cursor turn adds to coverage and never adds invented tokens. Both run at SessionEnd. Grok writes
  `turn_completed` after its Stop hook, so a read at Stop would split a turn from its usage. Grok's
  payload names no transcript, so the path comes from `cwd` + `sessionId`. Checked over every local
  session: each Grok session's `tool_uses` matches Grok's own `tool_completed` count within 1 (613
  vs 612 in one of 8). Gap: headless Grok wakes (`grok -p`) fire no `session_end`, so their R2
  waits on a host-side read at wake exit.
- **2026-09-28 — OpenCode is tapped on both rails** (lane `01M3MGQ6M158K3398BZVC6MDP5`). OpenCode
  has no hook table, so the doorbell plugin carries the tap (generation 2). R1: the tool-boundary
  probe gets the call's structural fields on stdin under `--hook opencode`, so `PostToolUse` rides
  a process that already runs. Each `session.idle` fires `trace hook --kind Stop`. R2: OpenCode
  keeps no transcript file. `opencode@1` reads completed assistant messages and their parts from
  `opencode.db` through the `sqlite3` CLI, as `observeModel` already does. The cursor is the last
  message's `time_created`. One message is one `usage`, with the message's tokens and its `tool`
  parts as `tool_uses`. On the largest local session the read matched the store exactly: 479 tool
  parts over 457 completed messages, 0 unknown parts. A machine without `sqlite3` records R1 only.
- **2026-09-28 — `trace.coverage_low` is written** (lane `01M3MG7KH30X95DJ75SVMDFMYQ`). An hourly
  daemon sweep judges each session that has been quiet for 30 minutes, not at SessionEnd, because
  every harness posts its final R2 rows after SessionEnd. A session with an R2 tool count and R1/R2
  below 0.98 gets one audit row with both counts. A session only one rail reached is not judged.
  The numerator changed twice, here and in `report trace`. It now counts `PostToolUseFailure`,
  because R2 counts a failed call (one session read 124/127 before, 127/127 after). It now leaves
  out subagent calls (rows with `agent_id`), because their transcript is a sidechain file R2 does
  not read. Those were 307 of the 382 calls by which claude-code's 30-day R1 exceeded R2, so
  claude-code went from 1.098 to 1.019. A dry run over the live `trace.db` flags 6 Claude Code
  sessions. Two were diffed against their transcripts, and neither miss is a tap failure: every
  missing call was refused before it ran (a permission check, a blocked command) and so fired no
  Post hook, or was a hookless built-in (`ToolSearch`). Open for nick: keep that definition, or
  have R2 subtract never-run calls from its denominator (a `claude-code@2` parser that reads
  `tool_result` errors).
- **2026-09-28 — coverage matrix, baseline** (lane `01M3MG7Q650Z8C5DKZKGJ31MDG`). Read from the
  dogfood box's `trace.db` over 30 days, all seats, structural columns only, with the numerator
  above. Target ≥ 0.98.

  | Harness     | Sessions | With R2 | R1 main calls | R2 calls | Coverage | Why                                         |
  | ----------- | -------- | ------- | ------------- | -------- | -------- | ------------------------------------------- |
  | claude-code | 63       | 31      | 3,977         | 3,902    | 1.019    | over 1: live sessions' last turn not tailed |
  | codex       | 9        | 9       | 1,360         | 0        | null     | `codex@1` emits no `tool_uses`              |
  | cursor      | 6        | 0       | 766           | —        | null     | `cursor@1` landed today (#1783)             |
  | grok        | 0        | 0       | —             | —        | null     | R1 tapped today (#1782), R2 today (#1783)   |
  | opencode    | 0        | 0       | —             | —        | null     | both rails landed today (#1785)             |
  | native      | 0        | 0       | —             | —        | null     | no tap (lane `01M3MGQC0J`)                  |

  The codex row is a parser gap: `token_usage_record` carries no tool count, so R2 never gives a
  denominator. Re-run this table once grok, cursor and opencode seats have run on today's build.
  Falsifier for the claude-code row: a finished session (quiet ≥ 30 min) whose main-loop R1 count
  is above its R2 count.
- **2026-09-28 — `codex@2` counts codex's tools** (with lane `01M3MG7Q650Z8C5DKZKGJ31MDG`). The
  denominator is `event_msg.item_completed` items that are tools (`CommandExecution`,
  `McpToolCall`, `FileChange`, `Extension`), not the `custom_tool_call` response items. In code
  mode one `exec` call runs several nested tools and codex's hook fires for each, so counting
  `exec` calls read R1 at 128% of R2. A tool completes after the usage record of the model call that
  issued it, so each completion is credited to the preceding usage record. On big-body's four
  rollouts on disk, R1/R2 per session: 343/340, 156/158, 10/10, and 239/269. The last one's R2
  excess is unexplained; the likeliest cause is calls made before the session's R1 tap was
  installed.
- **2026-09-28 — coverage matrix, second read** (lane `01M3MG7Q650Z8C5DKZKGJ31MDG`). The daemon
  reached `7d46d080` at 21:21Z, the first build carrying `codex@2`, `cursor@1`, `grok@1` and the
  opencode taps, so no R2 row from those parsers exists yet (the newest codex `usage` row is still
  `codex@1`). Read instead by re-parsing the transcripts on the dogfood box with this build's
  parsers and joining each to its R1 session by seat workspace and start minute (the digest key
  is per seat binding, so it is not a join an admin can make from outside the seat). 30 days,
  main-loop R1 only, same numerator as the sweep.

  | Harness     | Sessions | R1 main | R2 calls | Coverage | Why                                                   |
  | ----------- | -------- | ------- | -------- | -------- | ----------------------------------------------------- |
  | claude-code | 79 (39 with R2) | 4,680 | 4,734 | 0.989 | daemon read (`report trace`, all seats)         |
  | codex       | 8 of 9   | 1,254   | 1,264    | 0.992    | offline `codex@2`; 9th excluded (tap installed 90 min in: 384/684) |
  | cursor      | 6        | 585     | 543      | 1.077    | offline `cursor@1`, numerator de-duplicated (see below) |
  | grok        | 0        | —       | —        | null     | no grok seat has run since #1782                      |
  | opencode    | 0        | —       | —        | null     | no opencode seat has run since #1785                  |
  | native      | 0        | —       | —        | null     | no tap (lane `01M3MGQC0J`)                            |

  Codex per session, R1/R2: 35/35, 53/53, 33/33, 107/108, 343/340, 10/10, 156/158, 517/527 — the
  last one was live at the read, so its tail lags the hooks. Codex is at target.

  Cursor is **not computable as recorded**: the raw ratio is 831/543 = 1.53 because the R1 tap
  records `afterShellExecution` as `PostToolUse` beside `postToolUse` for the same shell call — on
  cursor-agent too, not only the IDE (wanderer's 0e58c84e: 86 `postToolUse` Shell rows and 91
  `afterShellExecution` rows against 92 Shell calls in the transcript). Counting `postToolUse` rows
  only, per session R1/R2 reads 33/37, 317/262, 127/127, 22/26, 86/91 — five of six within 0.85–1.0
  and one at 1.21 whose Read rows (144) are twice the transcript's (73), unexplained. The transcript
  also carries calls that fire no hook (`Glob`, `GetDynamicTools`), which pulls the ratio under 1.
  Two follow-ups, neither in this lane: the sweep's and the report's numerator should count one
  `PostToolUse` per call for cursor (key on `detail.hook_event`, which is stored for exactly this),
  and the tap's "instead of `postToolUse`" note on cursor-agent is wrong and should say "beside".
  Falsifier for the cursor row: a cursor-agent session whose `postToolUse` count differs from its
  transcript's `tool_use` count by more than 2% once shell/MCP after-hooks are excluded.

  Grok and opencode wait on a seat running on this build; re-read then, from the daemon.
- **2026-09-28 — cursor's numerator counts one `PostToolUse` per call** (lane
  `01M3N78KVY3ZR6RG50T2S5XM7K`). Both consumers — `report trace`'s coverage rows and the
  `trace.coverage_low` sweep — now share one SQL aggregate (`POST_TOOL_USE_ONCE`): a row spelled
  `afterShellExecution` / `afterMCPExecution` in `detail.hook_event` counts only when the session
  has no `postToolUse` spelling at all, since then those rows are its whole record. On the dogfood
  box's six cursor sessions the numerator drops from 831 to 585 and the ratio from 1.53 to 1.077;
  the one session still over 1 (0e58c84e, 317/262) is the Read double-fire noted above, not the
  after-hooks. The tap's note in `trace/hook.ts` no longer says cursor-agent fires the after-hooks
  *instead of* `postToolUse` — it fires them beside. Falsifier: a cursor session whose report
  numerator exceeds its `postToolUse`-spelled main-loop rows while it has any.
- **2026-09-29 — the Read double-fire is a re-emitted call id, and one call id counts once** (lane
  `01M3N8GF8DTK2SQFSCV8WNMZK9`). The 144 Read rows of wanderer's 0e58c84e carry 106 distinct
  `tool_use_id`s: three ids fired `postToolUse` 7, 8 and 26 times, seconds apart, with identical
  input bytes — cursor-agent re-emits the hook for a call it is still on. Not a per-file fire
  (a multi-path Read is one id per path, `_0…_3`) and not a duplicate hook install (no two rows
  share a timestamp). `POST_TOOL_USE_ONCE` now counts distinct `COALESCE(tool_use_id, id)`, so a
  row without an id is still its own call and no harness reads lower than before. On the six matrix
  sessions the cursor numerator goes 585 → 505 (0e58c84e 317 → 249 against 262 in its transcript)
  and the ratio 1.077 → **0.930** — under target now, and the remaining gap is the transcript's
  side: calls with no hook at all (`Glob`, `GetDynamicTools`) and, on the IDE, a compacted
  transcript. Two things this read also found and did not fix: the 106 distinct ids still exceed
  the transcript's 73 Read blocks by 33, unexplained; and rows from that session's build carry a
  `tool_use_id` of two ids joined by a newline (`call-…\nfc_…`), which the tap has since cut to its
  first line. Falsifier: a session whose numerator exceeds its distinct main-loop call ids.
- **2026-09-29 — the 33-Read gap is model messages the transcript does not hold, not a tap fault**
  (lane `01M3NBTAC8HXSNVBJEW2D1M0GQ`; no code change). On 0e58c84e the 106 distinct Read ids
  come from 61 model messages (the `fc_<message>_<k>` companion id); the transcript holds 48
  Read-bearing assistant messages with 73 blocks, and the per-message shape is the same on both
  sides (mostly 1, up to 4–5). Ruled out: compaction — all 14 user turns are present with their
  timestamps and Shell reconciles per 10-minute bucket (86 ids vs 92 blocks); harness-issued reads
  at session start — the transcript's turn 1 holds those four `.cursor/rules` / `.grok/skills`
  reads; IDE-issued reads — this was cursor-agent. The extra 13 messages sit inside the two heavy
  turns (3 and 12), where the hook rate was highest and where the three ids re-emitted 7–26 times
  also sit; R1's tool calls for turn 12 end at 10:05 local while the transcript's turn runs to
  10:28. The best-supported reading is retried model responses: cursor-agent ran the tool calls of
  a response it then discarded, and the transcript keeps only the response it kept. Not provable
  here — the transcript carries no message or call ids — so R1 stands as the record of what ran and
  R2 as the record of what the model kept, and the ratio's residual on cursor is a harness property,
  not a tap gap. Nothing to change in the taps or the aggregate. What would settle it: a
  cursor-agent transcript format that carries `tool_use.id` (then R1↔R2 join by id, as Claude
  Code's does). Falsifier: a fresh cursor-agent session, ended cleanly, with no re-emitted id, whose
  distinct Read ids differ from its transcript Read blocks by more than 2%.
- **2026-09-29 — a payload's spelling outranks the hook line's word; a contradicting pair is a
  foreign run and records only its outcome** (lane `01M3NNAKJ9Q3XXFFV4GHFTCT7Q`). Cursor runs a
  workspace's `.claude/settings*.json` hook lines beside its own `hooks.json`. On schmidt's three
  cursor-agent sessions (`43483901`, `a19b7de1`, `f7d7bc1c`; 2026-09-28 19:14Z → 09-29 03:54Z) the
  Claude interrupt probe (`inbox --interrupt-check --hook claude-code`) received cursor-spelled
  payloads (`conversation_id`, `postToolUse`, `0_tool_…` ids) and stamped them `claude-code`,
  because `tapHook` let the caller's word beat the payload's spelling. Cursor's own
  `session observe --interrupt` line had already recorded the same calls as `cursor`, so 118 call
  ids sat under two harnesses: 130 `PostToolUse` + 130 `HookOutcome` rows filed as `claude-code`,
  which misattributes a Cursor seat's work in the per-harness split ADR 056 reads. `tapHook` now
  takes the payload's spelling first and the caller's word only when the spelling names no harness
  (Claude Code and Codex share one). When the two disagree, it posts only the probe's
  `HookOutcome`, under the payload's harness: the harness's own line records the call. The 260 rows
  already filed stay as recorded, because the trace store is append-only. A reader splitting by
  harness should drop the `claude-code` rows of any `session_digest` that also has `cursor` rows.
  That catches both kinds: the `PostToolUse` rows carry `detail.hook_event = 'postToolUse'`, which
  is cursor's spelling and never Claude Code's, but the `HookOutcome` rows carry no `hook_event`. Falsifier: a `session_digest` with rows under two
  harnesses, or one `tool_use_id` recorded under two harnesses, from a tap built after this note.
- **2026-09-29 — coverage matrix, third read: daemon-side, all seats, and what the daemon's own
  numbers are made of** (lane `01M3NMDWA9Q5WN0K8D9M1PQD0D`). `deriveTraceReport` over every
  seat, 30 days, `POST_TOOL_USE_ONCE`. To get grok and opencode rows at all: ghost's opencode
  plugin was still generation 1 (no tap) and grokbot had no `.grok/hooks/musterd.json` — neither
  wake self-heal had repaired them (lane `01M3NMZ94D`); `init --refresh-hooks` in each workspace,
  then one steered errand each.

  | Harness     | Sessions (with R2) | R1 main | R2 calls | Report reads | What the number is                                                    |
  | ----------- | ------------------ | ------- | -------- | ------------ | --------------------------------------------------------------------- |
  | claude-code | 89 (44)            | 5,526   | 6,756    | 0.818        | dead-lease sessions drop R1 (below); clean sessions 0.96–0.98         |
  | codex       | 11 (3)             | 769     | 1,289    | 0.597        | one session's R2 tailed 5×; the two clean `codex@2` sessions 0.994, 1.000 |
  | cursor      | 8 (1)              | 78      | 188      | 0.415        | R2 tailed twice (94 + 94); the IDE session is 78/94 = 0.83            |
  | grok        | 1 (0)              | 0       | 0        | null         | `grok -p` loaded only the global hooks; no `session_end` headless     |
  | opencode    | 1 (1)              | 7       | 15       | 0.467        | R2 spans two wakes, the tap only the second: 7/7 = 1.00 on it         |
  | native      | 0                  | —       | —        | null         | no tap (lane `01M3MGQC0J`)                                            |

  Five things the daemon-side read exposed, each with its evidence and its lane:
  1. **A refused interrupt probe drops the R1 tap.** My own session (b7bed855) has `usage` rows
     from 12:56 and `PostToolUse` rows only from 20:51 — the minute `claim --detach` re-occupied
     the seat. Its lease had been dead since start (the defect ADR 471 / #1801 fixed today), every
     probe was refused, and the tap that rides the probe went with it: 50/279 = 0.18 for the day.
     miley's b8702e0b (84/494) is the same shape. That, not a tap gap, is claude-code's 0.818; the
     ten clean sessions read 0.96–0.98. ~~The tap should post even when the probe is refused.~~
     **Corrected 2026-09-29** (lane `01M3NNJQV1RC738XMBSQG8QVNC`): the mechanism above is wrong.
     A refused probe still posts — a garbage lease yields `PostToolUse` + `HookOutcome deaf:1`
     on the current build, and every build that ran through the gap awaited the tap on that path.
     What happened is a **split digest**: `claim --detach` on a re-occupy claims with the seat
     credential and wrote it as `binding.agent_key`, so `sessionDigest(agent_key, session_id)`
     moved. My session is whole under 27f7954d (176 R1, 144 R2, its SessionStart) until 20:50,
     then whole under b7bed855; the new digest had no tail cursor, so R2 re-posted the entire
     transcript with its original timestamps — the "usage from 12:56" was that re-tail, and item
     2's family. Per digest the ratio is meaningless; per session it is at target. Fixed in the
     detached claim: `agent_key` stays the team key, the credential rides beside it (test:
     `claim.test.ts`, re-occupy keeps `agent_key`). Falsifier: a `claim --detach` re-occupy after
     which `binding.agent_key` starts with `msac_`.
  2. **The R2 tail re-posts spans.** codex 0cd68449 posted the same range at 17:19:43, 17:19:50,
     17:21:12 and 17:23:59 (81 rows / 87 calls each), then 162/174 and 372/369 — 1,115 counted
     against 596 hook calls. cursor f7d7bc1c carries two `SessionEnd` and two `usage` rows in one
     second, 94 + 94. Sessions the tail touched once are at target (codex 159/160, 14/14). Not the
     16-cursor cap (big-body holds 6); the rewind is in `tail.ts` and needs its own read.
  3. **A rail that cannot count is no denominator.** `codex@1` usage rows carry tokens and no
     `tool_uses`; counted as "with R2" they put 11 sessions' hook calls over 1,289 and read 1.47.
     Fixed here: `has_r2` requires a `tool_uses`-bearing usage row (11 → 3 sessions).
  4. **New parser tags normalize to `other`.** Every `usage` row since the new build carries
     `parser: "other"` — `traceSync`'s per-field enum admits the values it knew (`claude-code@1`,
     `codex@1`) and folds the rest. Same for opencode tool names (`bash`, `read`, `musterd_*` →
     `other`). The values list needs `codex@2`, `cursor@1`, `grok@1`, the opencode tag, and an
     opencode tool namespace.
  5. **`grok -p` does not load project hooks.** grokbot's `updates.jsonl` names only
     `global/settings:*` and `global/musterd-sessionstart` hooks across 42 tool calls; the
     `.grok/hooks/musterd.json` written minutes earlier never ran. The wake also failed Presence
     attestation ("no roster Presence attesting this wake lease") though the seat answered.

  Read together: opencode's tap is complete on the wake it covered (ids match one for one),
  codex is at target where the tail ran once, and cursor's 0.83 on the IDE is the compaction and
  retry family already on this ADR. Falsifier for this note: a session with a live lease, tailed
  once, whose report ratio sits below 0.96 on claude-code or codex.
- Risk: the trace store grows fast. `trace.db` isolates that growth from `musterd.db`'s lock and
  backup path; the 30-day content prune bounds it; `musterd status` reports the file's size.
- **2026-09-29 — a Grok wake was loading only global hooks.** The project file
  `.grok/hooks/musterd.json` holds the R1 tap. Grok skips it until the git common-dir root is
  folder-trusted, and ADR 352's wake argv never passed `--trust`, so a grokbot wake recorded 42
  tool calls and zero R1 rows. [ADR 473](473-grok-wake-trusts-the-repo.md) puts `--trust` on the
  wake. The tap itself is unchanged.
- **2026-09-29 — the R2 tail re-posted spans it had already stored** (lane
  `01M3NNJCX9EYFGTZE32QXH3C0X`). Codex `0cd68449` holds one 256-event chunk (14:51–15:20) eight
  times, received 17:19–17:25. Two causes, both on the client. (1) The tail posted under the
  per-tool-call budget of 1.5 s. A chunk that landed after it read as failed, the cursor held, and
  the next hook re-read and re-posted the whole delta. (2) Two hooks firing together (codex
  `post-tool-use` + `end`; six chunks in one second at 17:25:04) read one cursor before either
  advanced it. The tail now posts under its own 10 s budget (`TAIL_POST_BUDGET_MS`) and holds
  `.musterd/trace-tail.lock` (O_EXCL) while it reads and posts; a hook that finds it held skips,
  and a lock older than 5 min is broken. Residual: a chunk the daemon stored whose reply was lost
  still re-posts once; an ingest-side dedupe would close it and needs its own ADR. Falsifier: two
  R2 rows for one digest from one transcript span with different `received_at`, on a build with
  this fix.
- **2026-09-29 — the new parsers were stored as `parser: "other"`** (lane
  `01M3NNK27K7BHWHVXBH8TCN5BA`). `traceSync`'s parser list stopped at `codex@1`, so 4,294 `codex@2`
  rows, 76 `cursor@1` and 32 `opencode@1` were stored as `other`, and every OpenCode tool name too.
  [ADR 474](474-trace-structural-values-grow-with-each-tap.md) makes the parser tag pattern-typed
  and gives OpenCode a tool namespace. Rows stored before the daemon runs that build stay `other`.
- **2026-09-29 — coverage matrix, fourth read: one steered errand per harness on the fixed build**
  (lane `01M3QQV53CC6EJ5PTQG1CANK89`). Daemon on `02a0e0a0` → `293e24db` (both carry #1820,
  #1824, #1830, ADR 473 and ADR 474); `deriveTraceReport` over every seat, 1 day, then the errand
  session on its own. The errand: fetch, read one ADR, run the protocol suite, post one status.

  | Harness     | Report (1d)            | Errand session                   | What the number is                                                   |
  | ----------- | ---------------------- | -------------------------------- | -------------------------------------------------------------------- |
  | codex       | 1.024 (9 sessions)     | gptbot `ed335d68`: 8 / 7 = 1.14  | tailed once (one `SessionEnd`), tag `codex@2`; the re-post is gone   |
  | opencode    | 0.938 (1 session)      | ghost `c1215543`: 8 / 9 = 0.89   | tag `opencode@1`, tools `bash` / `musterd_team_send`; not `other`    |
  | grok        | null (1 session)       | grokbot `664ddb76`: 0 / 0        | 12 `PreToolUse`, 0 `PostToolUse`, 0 `usage` — see below              |
  | cursor      | 0.011 (7 sessions, 1 with R2) | wanderer `0688c864`: 100 / 0 | an open IDE session; R2 posts only at `SessionEnd`                  |
  | claude-code | 0.800 (65 sessions)    | —                                | not re-run; the dead-lease split-digest family (2026-09-29 above)    |

  Read together: the two fixes this read was for hold. Codex is at target and tailed once, and
  every codex `usage` row received after the 12:24 daemon refresh carries `codex@2` (the 993 `other`
  rows received 17:19–18:13 yesterday are #1824's re-post, stored before ADR 474 ran). OpenCode's
  tag and tool namespace are right on the first session after the fix. Three things it exposed:
  1. **Grok's R1 is not in the numerator.** The Grok tap records every call as `PreToolUse` (its
     probe has no matcher; 2026-09-28 above), and `POST_TOOL_USE_ONCE` counts `PostToolUse` /
     `PostToolUseFailure` only — so a Grok session reads R1 = 0 by construction, whatever the tap
     did. And a headless wake (`grok -p`) fires no `session_end`, so its R2 never posts either: the
     "host-side read at wake exit" (2026-09-28 above) is still unbuilt. Grok's row stays `null`
     until both land; neither is a tap gap. Disposition: deferred — until a Grok seat carries a
     lane worth reading, then one lane for the numerator and the wake-exit tail (2026-09-29).
  2. **A wake that starts before its Presence probes deaf.** grokbot's session has three
     `HookOutcome {hook: interrupt, deaf: true}` rows at 16:36:21–16:36:30, before
     `ws_claim_occupied` at 16:36:30, then four clean probes. The tap still posted (the corrected
     mechanism above), so coverage is unaffected; the probes are.
  3. **An actuator bounce mid-wake defers every lease it held.** The three steers went out at
     16:35:50–53; autorefresh restarted the wake actuator at 16:36:23 (main had moved). grokbot's
     run completed (status at 16:37:39) but its lease and ghost's never-spawned lease were both
     reported `host_unreachable` at 16:37:57 and expired. A second steer to ghost at 16:42 woke it
     in 8 s. Not a trace defect; a residency one — lane `01M3QRYZM2XTJSPWRGBYMSZ535`.
  Cursor's number is the shape of the harness, not a regression: an attached IDE session tails R2
  once, at its end, so a read taken while the session is open sees R1 only (wanderer's 100 hook
  calls, 0 `usage`). The one cursor session with R2 in the window is yesterday's `f7d7bc1c` (94 + 94
  re-post, pre-#1824). Falsifier for this read: a codex or opencode session on a build ≥ `293e24db`
  whose ratio sits below 0.96 with one `SessionEnd`; or a cursor IDE session, ended after this note,
  whose `usage.tool_uses` is not within 5% of its `postToolUse` count.
- Cost: one hook round-trip per tool call already exists (ADR 150); R1 adds a payload to it and a
  batched POST, so the per-call overhead is what the gate costs now. R2 is a file tail.

## Observability & Evaluation

- **Traces:** the `TraceEvent` rows themselves are the trace; the daemon adds a
  `musterd.trace.ingest` counter (harness, kind, dropped) and the tap logs its drop count locally.
  Coordination acts gain nothing new; the join is by session digest and `tool_use_id`.
- **Eval:** per session, **coverage** = tool calls seen by R1 ÷ tool calls in the harness transcript
  (R2's count), and **reasoning coverage** = turns with a reasoning event ÷ turns. Dataset: every
  dogfood session after increment 2 lands; baseline today is 0 / 0 (nothing is captured). Target
  ≥ 0.98 tool coverage on Claude Code and Codex; a session below it is audited as
  `trace.coverage_low`.
- **Experiment:** run one seat through a real lane with all three rails on, then reconstruct the
  lane's wasted-work and coordination-token ratio (finding 001's hand-computed numbers) from
  `trace_events` alone; the numbers must match a hand read of the transcript within 5%.
