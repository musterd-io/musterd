# Idle-at-prompt wake — design

**Status:** approved 2026-10-10 (nick). Plan: [`2026-10-10-idle-wake.md`](../plans/2026-10-10-idle-wake.md), which also records the planning corrections (`seam`, `.musterd/idle-wake.json`). Lane
`01M4C2NTYQCFDRF4EJD2H1AB4E`. Goal: `idle-wake`. The ADR follows this spec (increment 1).

## What this is for

Leave a seat's session open and walk away. When a teammate directs an act at that seat, the open
session takes a turn and answers — on every harness that can be pushed — instead of the act waiting
until a human next types into it.

## The incident that opened the lane (2026-10-07)

ghost ran an opencode TUI session that sat idle at its prompt for hours, heartbeating the whole time. It
held 9 acceptance asks and returned 0 verdicts. Two things kept every one of them silent:

- The seat had live presence, so the daemon never derived a wake lease for it: `claimWakeLeases` skips
  any seat with `hasLivePresence` (`packages/server/src/store/residency.ts:1711-1719`).
- The ADR 392 plugin rings only on the `session.idle` **transition**
  (`packages/cli/src/onboard/harnesses/opencodePlugin.ts:165-183`). An act that arrives after the session
  went idle rings nothing.

## What happens today (read at `3a4321e2e`, 2026-10-10)

- **The push already reaches the adapter and stops there.** The daemon pushes every directed act to each
  of the recipient's sockets (`packages/server/src/protocol/route.ts:704`). The adapter's `deliver`
  handler buffers it (`packages/mcp/src/client.ts:1572-1574`); the buffer is drained only inside
  `team_inbox_check`. The adapter sends no MCP notification of any kind.
- **The only rails are tool boundaries and turn ends.** The PostToolUse probe (claude-code, codex),
  `postToolUse` (cursor), PreToolUse (grok), the plugin fence (opencode), the native bridge — and grok's
  Stop block and opencode's `session.idle`, both at the end of a turn. None fires at an idle prompt
  (`docs/design/daemon-doorbell-contract.md` clause 2: "today no harness covers it without an external
  wake").
- **After 60 minutes of transcript silence the adapter drops presence** (`SESSION_STALE_MS`,
  `packages/mcp/src/sessionLiveness.ts:26`). The daemon then derives a wake lease, and the host defers it
  as `attended-session-open` — but only for claude-code, the one harness with a process signature
  (`packages/cli/src/session/attendedProcess.ts:37-39`). The deferral backs off from 5 to 60 minutes
  (ADR 485). Still nothing reaches the open prompt. ADR 444 says the act "is delivered when the seat is
  next idle"; nothing implements that.
- **Today's interrupt set is narrower than the idle set below.** `pendingInterrupts`
  (`packages/server/src/store/messages.ts:525`) rings steers, `meta.urgent`, routed `lane_review`
  asks, eligible-set acts and huddle turns. A plain directed `ask`, `request_help` or `handoff` never
  rings.

## Decisions taken in the design conversation

1. **On by default** for every directed act listed under "What rings".
2. **Configurable at three levels:** team policy default, per-seat override, per-session override.
3. **A harness that cannot be pushed is "live but deaf".** The roster says so, and senders and pickers
   prefer a seat that hears. No ring to the human for it: the human doorbell (ADR 443) is unchanged.
4. **The shared core lives in the MCP adapter** (approach 1 of 3; the wake host and per-harness
   hooks were rejected — see "Considered and rejected").

## Design

### 1. What rings

A **directed** act — addressed to this seat by name, or naming it in an eligible set — of one of:
`steer`, `ask`, `request_help`, `handoff`, a `lane_review` ask, or a huddle turn that names the seat.
Team-addressed acts never ring the idle rail. Neither do `message`, `status_update`, `insight`,
`accept`, `decline`, `resolve`, `wait`, `challenge`, `defer`, unless they are `meta.urgent` (which
already rings at boundaries and rings here too).

The rule is one pure protocol function, `idleRingable(env, seat)`, beside `ringTargets` in
`doorbell.wire.ts`, so the daemon and `/live` read the same rule.

**The daemon composes the line** (ADR 088 §4). The adapter calls `GET /inbox/interrupt-check?seam=idle`. (`rail` already names the harness, ADR 423, so the seam is its own parameter.)
That route applies `idleRingable` over the same candidate window as today, runs the same discharge
predicate (ADR 434, `store/discharge.ts`), and returns the same act-id line ADR 088 amendment 4 composes
(`team_inbox_check {ids:[…]}` / `musterd inbox --id …`). It writes `interrupt.raised` with
`seam: 'idle'` beside the harness `rail` (ADR 423), once per (seat, act), exactly as the boundary seam does.

### 2. The core loop (in `@musterd/mcp`)

1. A `deliver` frame arrives for an act that `idleRingable` accepts.
2. The adapter checks the switches (§5). Off → stop.
3. It checks **idle**: no MCP tool call in flight in this adapter, the harness's last turn has ended (a
   turn-end marker the Stop / `session.idle` hook writes to `.musterd/idle-wake.json`), and the session
   transcript has not moved for 15 s.
   - Busy → stop. The boundary seam already carries the act at the next tool call.
4. It waits a **coalescing window** of 5 s, so a burst becomes one line.
5. It calls `interrupt-check?seam=idle`. No line (already discharged, already rung) → stop.
6. It applies the **guards** (§3), then calls `inject(line)` on this harness's inject adapter (§4).
7. It records the outcome (§6).

**Neutrality.** Injecting moves neither presence nor the inbox cursor. The act is discharged the normal
way — the woken model reads it by id (`inbox.rendered`) or answers it — exactly as for a boundary ring.

**Catch-up.** When the adapter's socket (re)opens, it runs step 3 onward once, so an act that arrived
while it was disconnected still rings.

**Staying present while armed.** An adapter that is **armed** — its inject adapter's `probe()` says
ready and its harness parent process is alive — does not drop presence at the 60-minute transcript-silence
verdict. Only an unarmed (deaf) adapter keeps today's release. Without this, every armed session would go
deaf after an hour and the wake host would start deferring against it again.

### 3. Guards

- **Once per act per session.** The daemon's `interrupt.raised` dedupe on (seat, act) already
  guarantees it; the adapter also keeps the ids it injected.
- **Ping-pong caps.** At most 3 idle wakes per hour from one sender to this seat, and at most 6 per hour
  per session in total. Over a cap, the act is not injected; it waits for the boundary seams and the
  adapter records `idle_wake.capped`. Two idle seats steering each other therefore stop after three
  rounds.
- **Human at the keyboard.** No harness exposes "the human is typing". The guard is a heuristic: no
  inject within 30 s of the human's last prompt (the UserPromptSubmit / prompt marker in the session
  file). Beyond that, the harness's own queueing decides what happens to a half-typed draft. That
  behavior is **unmeasured** on every harness and each canary records it.
- **Approval dialog open.** Unmeasured. Claude Code's inbox socket reads between tool calls, and codex's
  queue holds a message until the turn ends; neither is documented against an open approval prompt. The
  canary records it.

### 4. Inject adapters

One small module per harness in `@musterd/mcp`, with two calls:

- `probe(): { ready: true } | { ready: false, reason }`
- `inject(line): { ok: true } | { ok: false, reason }`

Turn markers (last prompt, last turn end) and the session switch live in `.musterd/idle-wake.json`, written
by the existing trace hook on `UserPromptSubmit` / `Stop` and by `musterd session idle-wake`. It holds no
secret. Anything a harness needs beyond that (codex's thread id) is the per-harness increment's to add.

| harness | inject | prerequisites | status at spec time |
| --- | --- | --- | --- |
| claude-code | Post the line to the session's **inbox socket** (`CLAUDE_CODE_MESSAGING_SOCKET`, token `CLAUDE_CODE_MESSAGING_TOKEN`). Documented: "When the receiving session is idle, Claude Code starts a new turn with the message." The stdio MCP server is a child of `claude`, so it may be an "own child" and may see the variables directly; the adapter reads them from its own environment (present in `claude` children, checked 2026-10-10 on 2.1.296); the token is never persisted. Wire format (NDJSON auth line, then a `user` message) is printed in Claude Code's own `[uds-messaging]` debug help. **Fallback:** a `notifications/claude/channel` event, when the musterd launcher started the session with the channels flag. | Claude Code 2.1.224+. Not in bare mode. Channel fallback: claude.ai or Console login, `--dangerously-load-development-channels server:musterd` during the preview, interactive only, `MCP_PROTOCOL_NEGOTIATION=legacy` if the adapter negotiates the 2026-07-28 MCP revision. | docs-confirmed; unmeasured |
| codex | `codex queue --thread <id> --message <line>` (app-server `thread/queue/add`). Release notes for 0.149.0: "Queued messages now wake idle sessions reliably". The thread id comes from the SessionStart hook. | codex 0.149.0+ (0.157+ auto-starts the queue daemon). Below that, `probe()` says deaf. | release-notes only; queue-wake fixes still landing in 0.162 (#51427, #51419) |
| opencode | The adapter writes a **ring file** in the session dir. The ADR 392 plugin watches it and calls `client.session.promptAsync`, so it rings *after* the session went idle, not only at the transition. The plugin's cap of 4 is replaced by the core's caps. | the ADR 392 plugin at the new generation | in-process call works "usually"; open #45564 reports ~90% no-turn on 1.18.22–23 over HTTP |
| grok | Deaf. | — | leader socket (`~/.grok/leader.sock`) is a lead, undocumented |
| cursor | Deaf. No hook starts a turn from idle; `stop` → `followup_message` is turn-end only. | — | documented boundary |
| native | Exempt: a native occupancy has no idle state. The rail is a new wake (ADR 131). | — | exempt |

**tmux `send-keys` and TIOCSTI are rejected** as an inject for any harness: they race the human's
keystrokes, can submit a half-typed draft or answer an open dialog, and carry no identity.

### 5. Switches

Later overrides earlier:

1. **Team policy** `idle_wake: boolean`, default `true`, in `ResidencyPolicySchema` beside
   `convene_huddles`. Set with `musterd residency policy --idle-wake on|off`.
2. **Per seat:** `musterd residency on <seat> --idle-wake on|off`.
3. **Per session:** `MUSTERD_IDLE_WAKE=off` at launch, or `musterd session idle-wake on|off` from inside
   the session. Both are read by the adapter (the env var directly; the command writes `.musterd/idle-wake.json`). The adapter re-reads the file before every inject, so the
   switch takes effect without a restart.

### 6. Hearing, and "live but deaf"

The adapter reports `hearing: 'idle' | 'deaf'` plus `hearing_reason` on claim and on every heartbeat.
`deaf` when the switches are off, `probe()` is not ready, or the last inject failed.

- **A failed inject flips the session deaf.** `inject()` returning not-ok, or no transcript movement
  within 60 s of an ok inject, sets `deaf` with the reason until the next successful `probe()`. A broken
  adapter must not keep claiming to hear.
- **Roster** shows "live · deaf" with the reason.
- **Pickers** — the eligible-set picker and the acceptance picker — prefer a hearing seat over a deaf
  one at otherwise equal rank.
- **The `team_send` reply** to a directed act whose recipient is live and deaf says so: "lands at its
  next tool call or prompt".
- **The wake host is unchanged.** ADR 444 still refuses a wake against an attended session, hearing or
  deaf.

### 7. Observability

- `interrupt.raised {seam: 'idle', rail: <harness>}` per idle ring (ADR 423 row, new `seam` field).
- `idle_wake.injected {ok, harness, reason?}` per inject; `idle_wake.capped {cap}` per capped act.
- `musterd report delivery` gains an idle-rail column: rung, turn within 60 s, discharged.
- **Baseline:** 0 idle rings to attended sessions today; ghost's 9 asks, 0 verdicts on 2026-10-07.

### 8. Testing

- **Unit:** the decider with a fake inject adapter — idle detection, the coalescing window, both caps,
  the 30 s keyboard guard, all three switches, catch-up on reconnect, the deaf flip.
- **Protocol fixtures:** `idleRingable` over every act type, directed vs team, eligible sets, huddle turns.
- **Daemon integration:** `seam=idle` dedupe, discharge, and the `interrupt.raised` row.
- **Live canary, one per harness:** a session idle for 2 minutes or more; a teammate sends a `steer`.
  Pass: the session's first turn starts within 60 s and the woken model reads the act by id. Record the
  half-typed-draft and open-dialog behavior while there. **Falsifier:** a ringable act to an armed, idle
  session that produces no `interrupt.raised {seam:'idle'}` row, or a row and no turn.

## Increments

Each is its own lane under `idle-wake`.

1. Lane `01M4M6PM79M093N5WKPX3Z8T7X`. **ADR:** `idleRingable`, the `seam=idle` route, `hearing`, and the `idle_wake` policy fields (protocol
   changes, hard rule 1).
2. Lane `01M4M6PXZT8ND6F17ZSBDKZQCS`. **Core + claude-code:** the adapter decider, guards, switches, `.musterd/idle-wake.json` turn markers, the
   inbox-socket inject, its canary.
3. Lane `01M4M6Q5ERZTP2GGHJZM71HP9R`. **opencode:** the ring file and the plugin watcher, replacing the transition-only bell; canary with a
   hit rate over N trials.
4. Lane `01M4M6Q8QKM2PK5E5T5AMF9E44`. **codex:** the `codex queue` inject; canary on the installed version.
5. Lane `01M4M6QP2JB8SPPHG3RKFFYW9P`. **Deaf handling:** roster, the two pickers, and the `team_send` reply.
6. Lane `01M4M6QCMMCC9PK53F4537TZTY`. **grok spike:** can a client on the leader socket put a prompt into the TUI's session?
7. Lane `01M4M6QE47M3XNVFEK5H2X4705`. **ADR 444 Consequences note:** "delivered when the seat is next idle" is now implemented for armed
   sessions.

Cursor stays deaf with no lane. Muse 1.4.10 stays deaf (lane `01M535CZQH`, 2026-10-16): no outside push, and `injectAdapterFor` stays `no-inject:muse`.

## Considered and rejected

- **The core in the wake host.** One process per machine and it already owns wake policy and cost caps,
  but it cannot tell which harness process is which session, the daemon may be on another machine, and
  it would poll.
- **A per-harness hook or plugin that waits on the daemon** (an opencode plugin long-poll, a Claude Code
  `asyncRewake` hook). Six copies of the guards — the opposite of one core. `asyncRewake` is also
  one-shot and bounded by its timeout, so it would have to be re-armed.
- **Ringing the human for a deaf session** (the ADR 443 doorbell). Declined in the design conversation.
- **A background wake beside the attended session.** Breaks ADR 444 and "never two sessions in one
  folder" (ADR 546).
- **Terminal injection** (tmux `send-keys`, TIOCSTI). See §4.

## Open, to be settled by measurement

- Whether Claude Code accepts the MCP server as an "own child" on the inbox socket, and whether
  `CLAUDE_CODE_MESSAGING_*` is in its environment.
- Whether `codex queue` against an idle **TUI** session starts and renders a turn on 0.162, and what it
  does with a half-typed draft.
- opencode's idle `promptAsync` hit rate on the installed version (#45564, #32010).
- What every harness does with an inject while the human is mid-draft or an approval dialog is open.
