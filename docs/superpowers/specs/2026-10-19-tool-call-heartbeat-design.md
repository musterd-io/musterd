# Tool-call heartbeat: the desk moves when the seat is really working

**Date:** 2026-10-19
**Seat:** miley
**Status:** design, from the brainstorm with nick on 2026-10-18 (whiteboard `broadcast-shipped-blocked`)
and his approval of [ADR 660](../../decisions/660-tool-call-heartbeat.md) on 2026-10-19 ("approve the
ADR, start the heartbeat lane"). Nothing is built yet.
**Lane:** `01M597Z3K6K0KN8FZRVYWVG3K5` (goal `live-delight`). The plan splits it into one lane per
increment; see the plan.
**Decision record:** ADR 660. This document is the builder's form of it and adds nothing to its
Decision; the frame schema below is the "left to the lane's spec" part.

## 1. What this is for

A stranger arriving mid-stream on `/broadcast` should leave thinking _"this team is actually
shipping real work, right now."_ Today the office draws a seat between acts as a figure at a desk,
and nick read that as fake: "too sequenced", members "aren't doing anything". Measured on
2026-10-18: 182 acts in three bursts, six gaps longer than 15 minutes, and the seats were building
through every gap.

The signal exists. Every harness tool call a seat makes already reaches the daemon within a second
or two as an ADR 445 trace row. This design turns those rows into one small per-seat pulse that the
office can react to, so the desk moves when, and only when, the seat is working.

**Success:** on `/live` and `/broadcast`, a seat heads-down for twenty minutes with no acts is
visibly working the whole time; a seat that is idle, or on a harness with no hooks, is still.
Perf and a11y gates stay green.

**Goals**

- Every desk motion traces to a real event in the last minute. No seeded loop, no fidget.
- Nothing of _what_ the seat is doing reaches a viewer: counts and one of four kinds, never a tool
  name, path, command or body.
- `/broadcast` and `/live` get the same pulse; the broadcast grade scrubs nothing because there is
  nothing to scrub.
- The cost per viewer stays inside the ADR 151 byte budget and adds no always-on loop.

**Non-goals**

- Not agent-internals observability (ADR 445 §1, `docs/design/observability.md` §7). No per-tool
  breakdown, no timeline, no drill-down.
- Not a replacement for presence or posture. Posture still says _at work_; the pulse says _working
  this minute_.
- Not the quiet-gap replay (lane `01M4V74S9E2E72SV53HC1GPYA9`). That decides what the stream shows
  when nobody is working; this decides how a working seat looks.

**Anti-goals** (would make this a failure even if it works)

- A seat looking busy from anything other than its own tool calls. If the hooks are off, the desk
  is still, and that stillness is the truth.
- A frame or a log line that leaks a filename or command. ADR 184's emitted ≠ published line holds.
- A viewer paying for the pulse while the tab is hidden.

## 2. What exists today (measured 2026-10-19)

**Ingest.** `POST /teams/:slug/trace/events` (`packages/server/src/transport/http.ts` ~7364) takes a
`TraceEventBatch` from the seat credential; the seat is `member.name`, never a body field. Each hook
process posts one event straight away, so there is no batching latency. `ingestTraceEvents`
(`packages/server/src/store/trace.ts`) writes `trace.db` and returns. **Nothing in the daemon fires
on ingest** — no emitter, no `hub` call. `ctx.hub` is in scope in the handler.

**Which rows count.** On Claude Code `PostToolUse` fires on every tool call; `PreToolUse` fires
only for the gated tools (Edit, Write, MultiEdit, NotebookEdit, Bash). Codex and Cursor post
`PostToolUse` only. So the one complete signal across harnesses is `PostToolUse` (and
`PostToolUseFailure`). The same route also carries transcript-tail rows (`reasoning`, `usage`, …)
and musterd's own `HookOutcome` rows; those are not work and are excluded. Cursor can post two rows
for one shell call (`postToolUse` and `afterShellExecution`), so counting is per `tool_use_id`.

**Tool names.** `tool_name` is normalized per harness by `structuralToolName`
(`packages/protocol/src/traceSync.ts`, `TRACE_TOOL_NAMESPACES`). Names outside the namespace are
stored as `other`; `mcp__*` names pass through. There is no kind classifier anywhere yet. Nothing
structural distinguishes a test run from any other shell command; only the command text could, and
it is content (off by default, and off-limits here).

**Stream.** `/ws` server frames are `WSServerFrame` (`packages/protocol/src/frames.ts` ~144): a
discriminated union with no version check on server frames; `LeaseFrame` is the recent precedent
for an additive push. Acts go out through `hub.broadcastFirehose`, which filters by visibility
grade; `/broadcast` connections are `broadcast` grade and receive a scrubbed copy
(`broadcastScrub.ts`). There is no server-side coalescing. **`heartbeat` is taken**: it is the
client→server presence frame every 15 s.

**Client.** `LiveClient` (`packages/web/src/live/client.ts`) switches on `frame.type` and ignores
unknown types, so an old bundle tolerates the new frame. State is `useState` in `useLiveStream.ts`;
`OfficeScene.tsx` feeds the canvas scene through `OfficeHandle.update(data)` and `handle.emit(ev)`.

**The desk today.** `skelFor` (`render.ts` ~3176) sets `typing = typingBurst(seed, t)` whenever
`posture === 'working'` and the figure is seated — a fixed 7–12 s cycle seeded from the name. The
monitor (`screenPanel`, `render.ts` ~3569) draws an animated desktop plus an additive bloom the
whole time `workingAtDesk` holds. `living()` keeps the rAF loop awake while any seat is
`workingAtDesk`. All of that is motion with no event behind it, and it is what ADR 660 §3 replaces.

**Budget.** `pnpm perf:check` gates bytes only (`docs/perf/budgets.json`); main sits about 500 B
under `totalJsGzipBytes` and about 270 B under `liveCssGzipBytes`. A raise, if needed, goes in the
same PR with the measured cost in `docs/perf/web-live-baseline.md`. Runtime cost is governed by
`packages/web/AGENTS.md`: a loop or interval stops when unseen.

## 3. The design

### 3.1 The pulse (protocol)

A new server→client frame, `seat_pulse`. Additive, so `musterd/0.3` stays; it is recorded as
SPEC Appendix A.25 (unreleased — ADR 660) and in `02-protocol.md`'s frame list.

```ts
// packages/protocol/src/frames.ts
export const PulseKindSchema = z.enum(['read', 'edit', 'run', 'test']);
export const SeatPulseFrame = z.object({
  type: z.literal('seat_pulse'),
  member: z.string().min(1),          // seat name, as `presence` frames use
  ts: z.number().int().min(0),        // daemon clock, ms, when this pulse was computed
  intensity: z.number().int().min(0), // distinct tool calls in the trailing 60 s
  kind: PulseKindSchema.nullable(),   // kind of the latest call in the window; null if none
  last_ts: z.number().int().min(0),   // producer ts of that latest call
});
```

Nothing else. No tool name, no session digest, no harness, no agent id. The frame is the whole
leak surface, and it is six scalars.

Two pure functions live beside it in `@musterd/protocol` so both halves test the same arithmetic:

- `foldPulseKind(harness, structuralToolName): PulseKind | null` — one table, derived from
  `TRACE_TOOL_NAMESPACES`: read tools → `read`; write/edit/patch tools → `edit`; shell/exec/task
  tools → `run`; `mcp__*`, `other`, plan/image tools → `null` (counted in intensity, no kind).
  `test` is never produced by this fold (see 3.4).
- `projectPulse(window: {tool_use_id, ts, kind}[], now): {intensity, kind, last_ts}` — distinct
  `tool_use_id` within `[now − 60 s, now]`, latest non-null kind. Pure, so the eval in ADR 660 can
  run it over `trace.db` rows offline.

### 3.2 The projection and the push (daemon)

A `SeatPulses` module in `packages/server/src/transport/`, held on `ctx`, keyed by
`(teamId, seat)`:

1. **Feed.** Right after `ingestTraceEvents` returns in the `/trace/events` handler, the accepted
   events are filtered to `PostToolUse` / `PostToolUseFailure` with a `tool_use_id`, folded with
   `foldPulseKind`, and appended to the seat's 60-second ring. Rows from the sync path
   (`/sync/trace`, ADR 453) are **not** fed in this increment; a seat on another node is still.
   That is a known gap, stated in Consequences, not papered over.
2. **Coalesce.** The first event for a quiet seat schedules a pulse `PULSE_MIN_GAP_MS = 5_000`
   later (not immediately — a burst of ten calls in two seconds is one pulse). Further events
   inside the gap only extend the ring. When the timer fires it computes `projectPulse` and pushes.
   A seat that stops calling stops pulsing: no "intensity 0" frames are sent, the client decays
   (3.3). This is what makes idleness honest and keeps the wire silent for a still room.
3. **Push.** `hub.broadcastFirehose(teamId, frame)` so the pulse reaches `team-all` subscribers at
   every grade; `scrubForBroadcast` passes `seat_pulse` through unchanged (it has nothing to scrub,
   and the test says so).
4. **Snapshot on subscribe.** On `subscribe team-all`, the server sends the current pulse of every
   seat whose ring is non-empty, so a viewer opening the page sees a working room within one frame
   instead of waiting up to five seconds.
5. **Bound.** Rings are trimmed to the window on every write; a seat with no event for 60 s is
   dropped from the map. Memory is O(active seats × calls per minute), a few KB.

The daemon's own tools are not fed: `mcp__musterd__*` calls fold to `null` kind but **do** count in
intensity, because a seat spending a minute on `team_send` is working. (ADR 660's note about
`tool_call_stats` is about where the number comes from, not about excluding them.)

### 3.3 The desk (web)

- **Client.** `LiveClient` gains `case 'seat_pulse'` → `onPulse(frame)`. `useLiveStream` keeps
  `pulses: Map<string, SeatPulse>` (by member name, replaced per frame). `OfficeScene` passes it
  through a new `OfficeHandle.pulse(member, pulse)` call; the scene stores it per `OfficeNode`.
- **Liveness.** A pulse is _live_ for `PULSE_TTL_MS = 15_000` after its `ts` (three missed
  pulses). `pulseIntensity(node, now)` returns the frame's intensity while live, then 0. There is no
  client-side extrapolation; stillness arrives within fifteen seconds of the last call.
- **Typing replaces the seeded loop.** `skelFor`'s `typing` becomes
  `typingFromPulse(intensity, t)`: 0 when intensity is 0; from 1 call/min upward a short tap
  burst whose duty cycle rises with intensity (about 25% at 1–2/min, about 85% at ≥12/min), still
  phase-seeded per seat so neighbours do not type in lockstep, but **the amplitude is gated by the
  pulse**, never by posture alone. `typingBurst` stays as the pure easing helper; its call site
  changes. A seat with posture `working` and no live pulse sits still at a lit screen.
- **Monitor.** `screenPanel` keeps the screen _on_ (lit, static desktop) while `workingAtDesk`
  — a lit monitor is a fact of being at the desk, not motion. The animated `drawScreenLife` and the
  additive bloom now run only while a pulse is live. A `run` kind adds a brighter bloom that eases
  out over 3 s from `last_ts`; a `test` kind (future, 3.4) flashes once. `edit` and `read` change
  nothing beyond typing, by design: the desk should not become a four-colour status light.
- **Loop parking.** `living()` reads "any seat with a live pulse" instead of "any seat
  `workingAtDesk`". With pulses TTL-bound, a still room parks the rAF loop within fifteen seconds —
  a perf improvement over today, where one `working` posture keeps it awake forever.
- **Room tone.** Typing sound follows the same `pulseIntensity`, so the room is quiet when still.
- **Reduced motion and STILL.** Unchanged: `if (reduced) return` still gates everything; the pulse
  only changes what motion is drawn when motion is allowed.
- **Replay on open.** `replay.ts` replays acts only; pulses are not replayed. The subscribe snapshot
  covers the first frame.

### 3.4 `test` — deferred, and why

Nothing structural says "this shell call was a test". Producing `test` honestly needs the hook
(client side, where the command text is visible for one process) to classify the command into a
tiny enum before posting — `detail.run_class: 'test' | 'build' | 'git' | 'other'` — and never
send the text. That is a new structural `detail` field on `TraceEvent`, a change to five harness
taps, and a judgment about what counts as a test runner. It is its own lane, after this one lands,
with its own Consequences note on ADR 660. Until then the fold never emits `test`, the frame's enum
already has it, and the monitor's flash is wired but never fires.

## 4. Constraints the builder holds

- Hard rule 1: the protocol change is recorded by ADR 660; the frame schema is recorded here and as
  a dated Consequences note on the ADR (its Decision is frozen). `pnpm change-adr:check` needs an
  ADR file touched in the same diff as any `packages/protocol/src` change — the Consequences note is
  that touch.
- Hard rule 4: the frame is parsed through `WSServerFrame` on the server side before send in tests;
  the web client does not run zod today and this design does not change that.
- Hard rule 5: nothing in a pulse, a log line or a test fixture may carry a tool name beyond the
  fold's input, a path, or a command.
- No new runtime dependency.
- `packages/web/AGENTS.md`: no new interval. Liveness is read from `ts` at draw time; the rAF loop is
  the only clock.
- ADR 151: if `totalJsGzipBytes` or `liveCssGzipBytes` must rise, the raise is in the same PR with
  the measured number in `docs/perf/web-live-baseline.md`.
- Words: the frame is `seat_pulse` and the concept is "the pulse" in copy and code; "heartbeat" is
  the existing client→server presence frame and is not reused.

## 5. What is left to the builder

- Exact duty-cycle curve for typing versus intensity (3.3 gives the shape; tune on the dev preview).
- Where `SeatPulses` lives on `ctx` and how the timer is cancelled on team removal / shutdown
  (follow `reaper.ts` patterns).
- Whether the snapshot on subscribe is one frame per seat or one frame carrying an array. Default:
  one frame per seat, reusing the schema; a batched form is a second frame kind and not needed yet.
- The fold table's exact membership per harness, derived from `TRACE_TOOL_NAMESPACES` at build time
  rather than hand-copied, if that is cheap; otherwise a hand table with a test that every namespace
  entry is classified.

## 6. Acceptance

1. Open `/live` and `/broadcast` with one Claude Code seat heads-down (no acts) for twenty minutes:
   the desk types and the monitor is alive throughout; within fifteen seconds of the seat stopping,
   it is still and the loop parks.
2. A seat with `MUSTERD_NO_TRACE=1`, or on a folder without hooks, with posture `working`: lit
   screen, no typing, no bloom.
3. `scrubForBroadcast(seat_pulse)` is identity; no field of the frame can carry a string other than
   the member name and the kind enum (schema test).
4. Eval from ADR 660: over one day of `trace.db`, minutes in which a seat had ≥1 tool call but the
   projection would have shown intensity 0 — target 0 on Claude Code; Codex and Cursor numbers
   recorded as they are.
5. `pnpm perf:check` green, with any raise documented.
