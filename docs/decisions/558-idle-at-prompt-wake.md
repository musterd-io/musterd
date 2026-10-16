# 558 — Idle-at-prompt wake

- Status: accepted
- Date: 2026-10-10
- Deciders: nick (design approved in chat 2026-10-10: "On by default for every directed act the
  agent doorbell rings … But this should also be configurable"; the spec and plan approved the same
  day), izzo
- Lane: `01M4M6PM79M093N5WKPX3Z8T7X` (Goal `idle-wake`)
- Spec: [`2026-10-07-idle-wake-design.md`](../superpowers/specs/2026-10-07-idle-wake-design.md) ·
  Plan: [`2026-10-10-idle-wake.md`](../superpowers/plans/2026-10-10-idle-wake.md)
- Builds on: [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the interrupt line),
  [ADR 423](423-interrupt-delivery-records-its-line-and-rail.md) (`rail` on `interrupt.raised`),
  [ADR 434](434-a-discharged-act-never-re-wakes-its-seat.md) (discharge),
  [ADR 164](164-session-attested-presence.md) (session-attested presence),
  [ADR 443](443-the-doorbell.md) (the human doorbell)
- Leaves unchanged: [ADR 444](444-a-wake-never-displaces-an-attended-session.md) (a wake never
  displaces an attended session)

## Context

The daemon pushes every directed act to each of the recipient's live sockets
(`packages/server/src/protocol/route.ts:704`). The MCP adapter receives the `deliver` frame and
buffers it. Nothing drains that buffer until the model next calls `team_inbox_check`. The model
hears about an act at its next **tool boundary** (the ADR 088 probe) or at a turn end (grok's `Stop`,
opencode's `session.idle`). A session sitting idle at its prompt has neither.

The [doorbell contract](../design/daemon-doorbell-contract.md) clause 2 records the result: "No
harness in the room covers idle-at-prompt-waiting-on-a-human without an external wake actuator."
That actuator does not reach an idle seat either. `claimWakeLeases` skips any seat with live
presence (`store/residency.ts:1711-1719`), and ADR 444 refuses a wake against an attended session.
ADR 444 says a deferred act "is delivered when the seat is next idle". Nothing implemented that.

## Problem

On 2026-10-07 ghost ran an opencode session that sat idle at its prompt for hours, heartbeating the
whole time. It held 9 acceptance asks and returned 0 verdicts. The seat looked live on the roster, so
senders and pickers kept routing to it. A live seat that cannot hear is worse than an offline one: an
offline seat gets a wake, and a live, deaf one gets nothing.

## Decision

### 1. What rings: `idleRingable`

A pure protocol function in `doorbell.wire.ts`, beside `ringTargets`:

`idleRingable(env, seat)` is true when the act is **directed** at `seat`, **not from** `seat`, and
either `meta.urgent === true` or the act is one of `steer`, `ask`, `request_help`, `handoff`.
Directed means addressed to the seat by name, or named by the act's eligible set (`meta.eligible`).
A `lane_review` ask is a directed `ask` and rings.

A team-addressed act never rings an idle session, and neither does any other act unless it is
urgent. A huddle turn rings through the existing live-set membership rule (ADR 378), which one
envelope cannot decide. `idleMayRing(env, seat)` (idleRingable, or any threaded act not from the
seat) is the adapter's cheap pre-filter. The daemon is the authority.

### 2. Who decides what: the daemon decides *what*, the adapter decides *when*

- The **daemon** answers `GET /teams/:slug/inbox/interrupt-check?seam=idle&rail=<harness>`. The
  candidate set is the live boundary set (steers, urgent, routed acceptances, huddle turns) plus
  every act `idleRingable` accepts. It is discharged by the same predicate as the boundary seam
  (ADR 434), extended: a directed `ask`, `request_help` or `handoff` is also discharged by an
  `accept`/`decline` naming it, or by the seat's own reply to it. The line is composed exactly as
  ADR 088 §4 and amendment 4 compose it, from structured fields, never a body.
- `seam` is a new query parameter, `boundary | idle`, default `boundary`. An unparseable value is
  `boundary`, never a 400. **`rail` keeps its ADR 423 meaning, the harness id.**
- `interrupt.raised` gains `detail.seam: 'idle'` on idle-seam rows only. Boundary rows are
  unchanged. The once-per-(seat, act) dedupe is shared across both seams: an act rung at a boundary
  is not rung again at idle, and the reverse.
- The **adapter** decides when: on a `deliver` that `idleMayRing` accepts, and once on every
  (re)connect so an act that arrived while it was away still rings. It waits a 5 s coalescing
  window. Then, if the session is idle (§4), it calls the daemon and posts the returned line to the
  harness's inject (§6).

### 3. Switches

Each later level overrides the one before:

1. **Team:** `ResidencyPolicySchema.idle_wake: boolean`, **default `true`**, set with
   `musterd residency policy --idle-wake on|off`.
2. **Seat:** the same key in the seat's sparse residency override (ADR 185), set with
   `musterd residency on <seat> --idle-wake on|off`. A seat that is not enrolled reads the team
   default.
3. **Session:** `MUSTERD_IDLE_WAKE=off` in the adapter's environment, or `switch: "off"` in the
   workspace's `.musterd/idle-wake.json`, written by `musterd session idle-wake on|off`. The adapter
   re-reads the file before every inject.

The daemon applies levels 1–2. When the effective `idle_wake` is off, `seam=idle` answers
`{raised: false, idle_wake: false}` and writes no row. The daemon never sees level 3.

### 4. Idle, and the guards

The adapter treats a session as **idle** only when all of these hold:

- no MCP tool call is running in this adapter;
- the last turn has ended (the last `Stop` marker is newer than the last prompt marker);
- the human's last prompt is at least **30 s** old;
- the session transcript has not moved for **15 s**.

The turn markers are in `.musterd/idle-wake.json`. The existing trace hook writes them on
`UserPromptSubmit` and `Stop`, so no new hook event is installed. The file holds no secret.

**Caps,** per adapter process: at most **3** idle wakes per hour from one sender and **6** per hour
in total. Over a cap the act is not injected and waits for the boundary seams.

**Neutrality:** injecting moves neither presence nor the inbox cursor. The act is discharged the
ordinary way, when the woken model reads it by id or answers it.

### 5. Hearing

The adapter reports `hearing: 'idle' | 'deaf'` and `hearing_reason` (≤ 80 characters) on
`HeartbeatFrame`. Both are optional, and absent means no change, never a clear (the
`guidance_epoch` rule). A session is `deaf` when any of these holds:

- a switch is off (`switch-off`, `policy-off`);
- the inject's `probe()` is not ready (for example `no-messaging-socket`, `no-inject:cursor`);
- the last inject failed (its reason);
- an ok inject produced no transcript movement within **60 s** (`no-turn-after-inject`).

`deaf` lasts until a later ready probe and transcript movement show otherwise. The daemon records
`presence.hearing {hearing, reason}` on each change, per connection.

An adapter that is **armed** (hearing `idle`) does not release presence on the ADR 164 `stale` rung
(60 minutes of transcript silence). An armed session at its prompt is reachable, so the roster must
keep it. The `ppid` and `ended` rungs still release.

### 6. Inject adapters

Each harness gets one module in `@musterd/mcp` with two calls: `probe()` and `inject(line)`.

- **claude-code:** Claude Code's inbox socket (v2.1.224+). The adapter reads
  `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` from its **own environment**: it is a child of `claude`,
  like a hook. The token is never persisted, logged, or echoed in a reason (hard rule 5). The wire
  format is newline-delimited JSON: `{"type":"auth","token":…}` when a token is set, then
  `{"type":"user","message":{"role":"user","content":<line>}}`.
- **Every other harness is deaf until its increment lands:** opencode (a ring file the ADR 392
  plugin watches), codex (`codex queue`), grok (a spike). Cursor stays deaf, because no Cursor hook
  starts a turn from idle. _(Amended 2026-10-16, lane 01M535CZQH, Muse Code 1.4.10: Muse stays deaf, and that is not an increment waiting to land. `muse session-message` returns `external_agent_ingress_closed`. A runtime-socket hello as `peer_runtime` authenticates (session `01a14675-e770-7d03-9d9a-e8469ed80e6b`). `session.user_message.submit` then returns `malformed_request` (session `01a14676-abf5-7f20-b3a0-1e1c41184ba3`) or, with no extra fields, `role_denied` (session `01a14677-f1fe-7730-b001-440ff16dd23e`). `peer_message.submit_agent` returns `malformed_request`. Canary `MUSEIDLECANARY9Q4` is absent from that day's session logs. `injectAdapterFor('muse')` stays `no-inject:muse`. No guessed private body is wired.)_ Native is exempt: a native occupancy has no idle state.
  _(Amended 2026-10-13: exempt from the idle seam, not from reach — a resident native seat (ADR 588
  §6) hears a directed act mid-turn through its engine's steering queue, with no idle state to wait
  for; it attests `hearing: idle` on its heartbeat and each delivery is a `residency.steered` row.)_
- **Terminal injection** (tmux `send-keys`, TIOCSTI) is refused for every harness. It races the
  human's keystrokes, can submit a half-typed draft or answer an open dialog, and carries no
  identity.

### 7. The outcome report

`POST /teams/:slug/inbox/idle-wake` takes an `IdleWakeReport`, a strict schema:
`{act, outcome: 'injected'|'failed'|'capped', harness, reason?, cap?: 'sender'|'session'}`. It never
carries the line. The route writes `idle_wake.injected {act, harness, ok, reason}` or
`idle_wake.capped {act, harness, cap}`. The adapter sends it with `x-musterd-no-touch: 1`, so a
report never fakes liveness.

### 8. Unchanged

- The human doorbell (ADR 443): a deaf session does not ring a human.
- The wake host and ADR 444: a wake is still refused against an attended session, hearing or deaf.
- The boundary seam's query and line: the idle seam is opt-in by parameter, and the boundary path's
  SQL and parameters are byte-identical.

## Considered and rejected

- **`?rail=idle`**, as the spec first wrote it. `rail` already names the harness on this route and
  on `interrupt.raised` (ADR 423). Overloading it would leave an idle row unable to say which
  harness it reached.
- **The core in the wake host.** The host already owns wake policy and cost caps. But it cannot
  tell which harness process is which session, the daemon may be on another machine, and it would
  poll.
- **A per-harness hook or plugin waiting on the daemon** (an opencode long-poll, a Claude Code
  `asyncRewake` hook). That means six copies of the guards. `asyncRewake` is also one-shot and
  bounded by its timeout.
- **A session-scoped file under `.musterd/session/` written by a new SessionStart hook,** holding
  the socket and token. The variables are already in the adapter's environment, so a file would put
  a secret on disk for nothing. The markers ride the trace hook that already fires on both events.
- **Ringing the human for a deaf session.** nick declined it in the design conversation.
- **A background wake beside the attended session.** It breaks ADR 444 and ADR 546 (never two
  sessions in one folder).

## Consequences

- `@musterd/protocol` gains `idleRingable`, `idleMayRing`, `InterruptSeamSchema`, `HearingSchema`,
  `IdleWakeReportSchema`, `IdleWakeStateSchema`, the `IDLE_*` constants,
  `ResidencyPolicySchema.idle_wake`, and `HeartbeatFrame.hearing`/`hearing_reason`. All are
  additive. A pre-558 daemon ignores `seam` and answers the boundary set; the adapter treats any
  line it gets back as authoritative. A pre-558 adapter never sends `seam`.
- On by default means every armed Claude Code session on a team can now take turns nobody typed,
  bounded by the caps. That is the point. The cost is a turn's tokens per ringable act, at most 6
  per hour per session.
- `hearing` lives only in the audit log for now. The roster, the two pickers, and the `team_send`
  reply that tells a sender its recipient is live but deaf are increment 5.
- The spec and plan were corrected while planning. The spec's `rail=idle` is now `seam=idle`. The
  spec's `.musterd/session/` file is now `.musterd/idle-wake.json`, with the socket read from the
  environment. The socket's wire format is not in Claude Code's public docs; it was read from the
  2.1.296 `[uds-messaging]` debug help, and the canary confirms it.
- _(2026-10-11, building increment 2.)_ Two corrections to the first bullet's compatibility story.
  First, every `seam=idle` reply echoes `seam`, and the adapter reads a reply without the echo (a
  pre-558 daemon that ignored the parameter) as silence, not as a line to push. Second, the idle
  line becomes a **user-role** turn in the receiving session, not hook output, so it is guarded
  twice. The daemon stays silent on the idle seam unless every field the line interpolates (team,
  sender, act id, thread, huddle topic) is a short plain token, because `id`, `thread` and a
  huddle's `topic.id` are sender-chosen strings the envelope schema bounds only by `min(1)`. The
  adapter also pushes nothing that is not one short printable line of the composed shape, and
  reports `failed` with reason `line-shape`. The boundary seam is unchanged and still carries such
  an act as hook output. Found by a commit security review during the build.
- _(2026-10-11, increment 2's canary.)_ Passed on Claude Code 2.1.296, n=1: a steer to a session
  idle for 6 h 46 m started a turn 5.2 s after the send ([the canary](../wiki/idle-wake-canary.md)).
  Claude Code frames the pushed line as a peer message (`origin.kind: 'peer'`) with a
  no-escalation rider, which is stricter than the user turn assumed above. The guards stay.
- _(2026-10-11, building increment 3.)_ Three changes from the spec's opencode row and from the
  Increments note that the per-harness increments change nothing else in the core.
  1. **The ring is three files**, not one. The adapter writes `.musterd/idle-ring.json` and waits up
     to 10 s for the plugin's `.musterd/idle-ring-ack.json`, so `idle_wake.injected` means opencode
     took the prompt, not that a file was written. The plugin (ADR 392, generation 5) stamps
     `.musterd/opencode-plugin.json`; without a fresh stamp the session is deaf by name (`no-plugin`,
     `plugin-stale`, `plugin-gone`). The shapes and the line check (`isPushableLine`, moved here from
     the adapter) are in `@musterd/protocol`, because the plugin renders them into its own text.
  2. **The core holds a busy session's acts.** Generations 1–4 of the plugin rang at the turn-end
     transition with their own probe and a cap of 4. That bell is gone, as the spec says, and its
     one case (an act that lands mid-turn with no tool call after it) moves to the core. A fire that
     finds the session busy keeps what waits and looks again every 15 s for up to 10 minutes. The
     daemon is asked only once the session is idle, and drops whatever a boundary seam delivered
     meanwhile. An inject the harness refuses as `busy` is held the same way, not counted deaf. The
     plugin refuses a session it saw go busy, because a `promptAsync` into a running turn orphans
     messages (#28202). This applies to Claude Code too.
  3. **The switch now covers the turn-end bell.** With idle wake off, opencode rings nothing at turn
     end, where generations 1–4 rang regardless. The boundary seam is unchanged.

  The plugin also records each turn start (`trace hook --kind UserPromptSubmit`, beside the existing
  `Stop`), so the turn markers and the keyboard guard have evidence on opencode.
- _(Amended 2026-10-16, lane 01M535CZQH, Muse Code 1.4.10.)_ Muse has no outside push. `muse session-message list` and `send --json` return `external_agent_ingress_closed` while a message-capable runtime socket exists. A `channel.hello` with `requested_role: peer_runtime` and `schema_version: 4` returns `authenticated`. From that role, `session.user_message.submit` returns `malformed_request` or `role_denied`, and `peer_message.submit_agent` returns `malformed_request` for an empty body and for a top-level `body`. `peer_message.submit_external_agent` and `session.permissions.inspect` return `role_denied`. The canary `MUSEIDLECANARY9Q4` does not appear in any session log from that day. Terminal injection stays refused. The adapter stays `no-inject:muse`.

Follows-up: lane `01M4M6PXZT8ND6F17ZSBDKZQCS` — the core and the claude-code inject, with its canary.
Follows-up: lane `01M4M6Q5ERZTP2GGHJZM71HP9R` — the opencode inject.
Follows-up: lane `01M4M6Q8QKM2PK5E5T5AMF9E44` — the codex inject.
Follows-up: lane `01M4M6QP2JB8SPPHG3RKFFYW9P` — deaf handling: roster, pickers, the `team_send` reply, and the `report delivery` idle column.
Follows-up: lane `01M4M6QCMMCC9PK53F4537TZTY` — the grok leader-socket spike.
Follows-up: lane `01M4M6QE47M3XNVFEK5H2X4705` — the ADR 444 Consequences note.

## Observability & Evaluation

**Traces.**
- `interrupt.raised {…, rail, seam: 'idle'}` per idle ring.
- `idle_wake.injected {act, harness, ok, reason}` per inject attempt.
- `idle_wake.capped {act, harness, cap}` per capped act.
- `presence.hearing {hearing, reason}` per change.

**Baseline.** 0 idle rings to attended sessions as of 2026-10-10. ghost held 9 asks and returned 0
verdicts on 2026-10-07.

**Eval.** Unit tests on the adapter's decider, with a fake clock and a fake inject, cover:
- idle detection, the coalescing window, both caps, the 30 s keyboard guard;
- all three switches, catch-up on reconnect, the deaf flip and its recovery.

Protocol tests cover `idleRingable` over every act type. Daemon tests cover the `seam=idle` set,
discharge, the shared dedupe, the `idle_wake:false` answer, and the report route.

**Experiment (the canary, plan Task 7).** Leave a Claude Code session idle at its prompt for 2
minutes or more, armed. A teammate sends a `steer`. Pass: within 60 s there are an
`interrupt.raised {seam:'idle'}` row and an `idle_wake.injected {ok:true}` row, the transcript shows
a new turn, and the woken model reads the act by id. Repeat 5 times for a hit rate. Record what
happens to a half-typed draft and to an open approval dialog, and whether Claude Code raised its own
held-message dialog (`crossSessionInbound`).

**Falsifier:** a ringable act to an armed, idle session that produces no `interrupt.raised` row
with `seam:'idle'`, or a row and no turn.
