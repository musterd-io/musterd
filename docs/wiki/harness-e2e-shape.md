# Harness end-to-end shape

Three harnesses hold onboard, wake, resume, meter, doorbell, and idle-wake; codex, cursor-agent, and grok each have a named gap (read 2026-10-16 at `0c5f3c0c`, lane `01M50ZJ9WD89`).

## How a cell was read

Holds means the named file does that job on this commit. A gap is an open lane. This page is the six-column walk. The [driver support matrix](driver-support-matrix.md) stays the per-driver environment record. The doorbell room stays [the daemon doorbell contract](../design/daemon-doorbell-contract.md); muse postdates that room, so its doorbell cell is here.

The read is the files below, at `0c5f3c0c` (2026-10-16; falsify: the named symbol no longer does what its cell says). <!-- claim: other -->

| Harness | Onboard | Wake | Resume | Meter | Doorbell | Idle-wake |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | holds | holds | holds | holds | holds | holds |
| opencode | holds | holds | holds | holds | holds | holds |
| native (`musterd`) | guidance | holds | holds | holds | holds | exempt |
| codex | holds | holds | holds | holds | holds in unit | gap |
| cursor-agent | holds | holds | holds | gap | holds | exempt |
| grok | holds | holds | holds | holds | holds | gap |
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

## cursor-agent holds except the meter (2026-10-16)

Onboard is `cursor.ts`: postToolUse `session observe --stdin --interrupt`, the PreToolUse gate, and sessionStart orient. Wake and resume are `host/backends/cursorAgent.ts` (`--resume`). Doorbell holds mid-turn in the doorbell contract (2026-09-14). Idle-wake stays deaf on purpose (ADR 558 §6); `injectAdapterFor` returns `no-inject:cursor`. Settle calls `deps.readUsage` only, and the reason is always `harness_price_unverified` (2026-10-16; falsify: `cursorAgent.ts` reads usage when `deps.readUsage` is omitted). <!-- claim: other -->

Follows-up: 01M535CZNQS8CCZGWR1834079N

## grok holds except idle inject (2026-10-16)

Onboard is `grok.ts`. Wake and resume are `host/backends/grok.ts` (`-r`). Meter is `readGrokWakeUsage` plus `harness_price_unverified`, because `costUsdTicks` is a price the host does not attest (ADR 364). Doorbell is PreToolUse `additionalContext` (ADR 370), measured 2026-09-03. `injectAdapterFor('grok')` returns `no-inject:grok` (2026-10-16; falsify: `inject.ts` returns a ready adapter for `grok`). <!-- claim: other -->

The leader-socket measurement stays on [Grok leader socket](grok-leader-socket.md). A default TUI has no socket. The inject for a `--leader` TUI is the gap.

Follows-up: 01M535CZQ2PJB4SVT586NS8SN2

## muse holds, idle deaf (2026-10-16)

Onboard is `onboard/harnesses/muse.ts` (SessionStart orient, Stop interrupt). Wake and resume are `host/backends/muse.ts` (`--session-id`, resume adds `--allow-workspace-switch`). Meter reads that session's `session.jsonl` and, when `model_completed.usage` parses, settles the summed tokens as `harness_prints_no_price` (ancestor `c42f00c4`). A log with no such event stays `harness_price_unverified` and carries no usage.

`museStopCommand` prints nothing when `interrupt-check` is silent. A non-empty line becomes `{"decision":"block","reason":"<line>"}`, and a continuation whose stdin has `stop_hook_active: true` exits 0. On Muse 1.4.10 a Stop hook that prints a bare line and exits 0 stores stdout as `""` and does not add a model step (2026-10-16, echo, session `eeeeeeee-3333-4333-8333-000000000003`; falsify: that bare line appears in a `context_block_updated` block). <!-- claim: other -->

The shipped wrapper reaches the next model step: the reason is a developer context block `hook:stop:stop:0` from `runtime_hook`, the first stop is `blocked`, and `stop_hook_active` makes the second stop `completed` (2026-10-16, echo, session `ffffffff-8888-4888-8888-000000000001`, two model steps; a silent check on `ffffffff-8888-4888-8888-000000000002` stays one step; falsify: that JSON is status `failed`, or the reason is absent from the next model step). <!-- claim: other -->

`additionalContext` is rejected on Stop.

`injectAdapterFor('muse')` returns `no-inject:muse` (2026-10-16; falsify: `inject.ts` returns a ready adapter for `muse`). <!-- claim: other -->

Idle-wake stays deaf on Muse 1.4.10 (ADR 558 §6). `muse session-message` returns `external_agent_ingress_closed`. A runtime-socket `peer_runtime` hello authenticates, and `session.user_message.submit` and `peer_message.submit_agent` return `role_denied` or `malformed_request` and the session log does not gain the line (2026-10-16, echo, sessions `01a14676-abf5-7f20-b3a0-1e1c41184ba3` and `01a14677-f1fe-7730-b001-440ff16dd23e`; falsify: an outside client puts a line into a Muse session). <!-- claim: other -->
