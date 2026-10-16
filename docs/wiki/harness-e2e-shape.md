# Harness end-to-end shape

claude-code, opencode, and grok hold onboard, wake, resume, meter, doorbell, and idle-wake; codex has the remaining named gap (read 2026-10-16, lane `01M535CZQ2PJB4SVT586NS8SN2`).

## How a cell was read

Holds means the named file does that job on this commit. A gap is an open lane. This page is the six-column walk. The [driver support matrix](driver-support-matrix.md) stays the per-driver environment record. The doorbell room stays [the daemon doorbell contract](../design/daemon-doorbell-contract.md); muse postdates that room, so its doorbell cell is here.

The read is the files below, at `0c5f3c0c` (2026-10-16; falsify: the named symbol no longer does what its cell says). <!-- claim: other -->

| Harness | Onboard | Wake | Resume | Meter | Doorbell | Idle-wake |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | holds | holds | holds | holds | holds | holds |
| opencode | holds | holds | holds | holds | holds | holds |
| native (`musterd`) | guidance | holds | holds | holds | holds | exempt |
| codex | holds | holds | holds | holds | holds in unit | gap |
| cursor-agent | holds | holds | holds | holds | holds | exempt |
| grok | holds | holds | holds | holds | holds | holds |
| muse | holds | holds | holds | holds | holds | deaf |

`HARNESSES` in `packages/cli/src/onboard/harnesses/index.ts` is claude-code, cursor, codex, opencode, grok, muse. `musterdAdapter` is guidance and is not selectable. Native is the engine. `packages/cli/src/commands/host.ts` constructs all seven wake backends.

## claude-code holds (2026-10-16)

Onboard is `claudeCode.ts`. Wake and resume are `host/backends/claudeCode.ts` (`--session-id` fresh, `--resume` for a captured id). Meter maps `total_cost_usd` onto `cost_usd`. Doorbell is PostToolUse `inbox --interrupt-check --hook claude-code`, measured live 2026-09-14 in the doorbell contract. Idle-wake is `trace hook --stdin` on `UserPromptSubmit` and `Stop` (`TRACE_HOOK_EVENTS`), and `injectAdapterFor` returns `claudeInbox`.

## opencode holds (2026-10-16)

Onboard is `opencode.ts` plus `opencodePlugin.ts`. Wake and resume are `host/backends/opencode.ts` (`run --session`). Meter sums stdout step usage, keeps `harness_cost_usd`, and settles `harness_price_unverified` with `cost_usd` absent (ADR 364). Doorbell is the plugin `tool.execute.after` probe. Idle-wake is `opencodeRing` plus `trace hook --kind Stop` and `UserPromptSubmit`, which write `.musterd/idle-wake.json` through `noteTurnMarker`.

## native holds, idle exempt (2026-10-16)

Onboard is `musterdAdapter`, guidance the engine appends. Wake is `nativeBackend`. Resume is the daemon wake-transcript rehydrate in `native.ts`, not a harness session id. Meter is the engine's `cost_usd`. Doorbell is `interruptCheck` and `appendInterrupt` in `nativeBridge.ts`. Idle-wake is exempt: ADR 558 §6 says a native occupancy has no idle state, amended 2026-10-13 to the idle seam only.

## codex holds except idle-wake (2026-10-16)

Onboard is `codexHooks.ts` (SessionStart, SessionEnd, PostToolUse, UserPromptSubmit). Wake and resume are `host/backends/codex.ts` (`resume`). Meter is the printed tokens plus `harness_prints_no_price`. Doorbell holds in unit (`codex-hook post-tool-use`); live delivery stays the 2026-09-15 cell in the doorbell contract and [codex live doorbell eval](codex-live-doorbell-eval.md). `injectAdapterFor('codex')` returns `no-inject:codex` (2026-10-16; falsify: `inject.ts` returns a ready adapter for `codex`). <!-- claim: other -->

Follows-up: 01M4M6Q8QKM2PK5E5T5AMF9E44

## cursor-agent holds, idle exempt (2026-10-16)

Onboard is `cursor.ts`: postToolUse `session observe --stdin --interrupt`, the PreToolUse gate, and sessionStart orient. Wake and resume are `host/backends/cursorAgent.ts` (`--resume`, `--output-format json`). Doorbell holds mid-turn in the doorbell contract (2026-09-14). Idle-wake stays deaf on purpose (ADR 558 §6); `injectAdapterFor` returns `no-inject:cursor`.

Meter reads the wake's stdout. cursor-agent 2026.10.14-941492e writes `{type:"result", usage:{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}}` and no dollar field when `--print --output-format json` is set (`--help` that day: text | json | stream-json, default text). `parseCursorAgentResult` maps those counts. A result with usage settles `harness_prints_no_price` and leaves `cost_usd` unset. No usage object leaves usage off the row and settles `harness_price_unverified` (2026-10-16; falsify: a successful `--print --output-format json` result on this build has no `usage` object, or that object carries a dollar field). <!-- claim: other -->

A credentialed `--print --output-format json` run the same day exited 1 before any result: the $10 additional-usage cap. Stdout was empty. That run's transcript jsonl held the error and no token fields, and local agent transcripts hold no usage file. The parser follows the writer in that build.

## grok holds (2026-10-16)

Onboard is `grok.ts`. Wake and resume are `host/backends/grok.ts` (`-r`). Meter is `readGrokWakeUsage` plus `harness_price_unverified`, because `costUsdTicks` is a price the host does not attest (ADR 364). Doorbell is PreToolUse `additionalContext` (ADR 370), measured 2026-09-03.

Idle-wake is `grokLeader`. Probe is ready only when the leader socket exists (`GROK_LEADER_SOCKET`, otherwise `~/.grok/leader.sock`). A missing socket is `no-leader-socket`, so a default TUI stays deaf. A `--leader` session is prompted only when `session/list` has a row whose cwd is the binding directory (2026-10-16, Grok 1.0.62; falsify: `injectAdapterFor('grok')` stays `no-inject:grok` when the socket exists). <!-- claim: other -->

The leader-socket measurement stays on [Grok leader socket](grok-leader-socket.md).

## muse holds, idle deaf (2026-10-16)

Onboard is `onboard/harnesses/muse.ts` (SessionStart orient, Stop interrupt). Wake and resume are `host/backends/muse.ts` (`--session-id`, resume adds `--allow-workspace-switch`). Meter reads that session's `session.jsonl` and, when `model_completed.usage` parses, settles the summed tokens as `harness_prints_no_price` (ancestor `c42f00c4`). A log with no such event stays `harness_price_unverified` and carries no usage.

`museStopCommand` prints nothing when `interrupt-check` is silent. A non-empty line becomes `{"decision":"block","reason":"<line>"}`, and a continuation whose stdin has `stop_hook_active: true` exits 0. On Muse 1.4.10 a Stop hook that prints a bare line and exits 0 stores stdout as `""` and does not add a model step (2026-10-16, echo, session `eeeeeeee-3333-4333-8333-000000000003`; falsify: that bare line appears in a `context_block_updated` block). <!-- claim: other -->

The shipped wrapper reaches the next model step: the reason is a developer context block `hook:stop:stop:0` from `runtime_hook`, the first stop is `blocked`, and `stop_hook_active` makes the second stop `completed` (2026-10-16, echo, session `ffffffff-8888-4888-8888-000000000001`, two model steps; a silent check on `ffffffff-8888-4888-8888-000000000002` stays one step; falsify: that JSON is status `failed`, or the reason is absent from the next model step). <!-- claim: other -->

`additionalContext` is rejected on Stop.

`injectAdapterFor('muse')` returns `no-inject:muse` (2026-10-16; falsify: `inject.ts` returns a ready adapter for `muse`). <!-- claim: other -->

Idle-wake stays deaf on Muse 1.4.10 (ADR 558 §6). `muse session-message` returns `external_agent_ingress_closed`. A runtime-socket `peer_runtime` hello authenticates, and `session.user_message.submit` and `peer_message.submit_agent` return `role_denied` or `malformed_request` and the session log does not gain the line (2026-10-16, echo, sessions `01a14676-abf5-7f20-b3a0-1e1c41184ba3` and `01a14677-f1fe-7730-b001-440ff16dd23e`; falsify: an outside client puts a line into a Muse session). <!-- claim: other -->
