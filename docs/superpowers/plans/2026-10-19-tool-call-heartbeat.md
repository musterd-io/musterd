# Tool-call heartbeat: implementation plan

> **For agentic workers:** implement in your own seat, one lane per PR (AGENTS.md hard rule 8 — no
> writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a per-seat `seat_pulse` frame, derived from ADR 445 trace rows as counts and kinds only,
that makes the office desk type and glow when, and only when, the seat is really working.

**Architecture:** one additive server→client frame and two pure functions in `@musterd/protocol`;
one daemon module that rings the last 60 s of tool calls per seat and pushes a coalesced pulse through
the existing firehose; one web change that replaces the posture-seeded typing loop with the pulse.
Nothing is persisted. Idle seats send nothing and the client decays.

**Tech stack:** TypeScript, zod (protocol), the existing `Hub` (server), Canvas 2D scene (web), vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-tool-call-heartbeat-design.md`. Read it first.
**Decision:** [ADR 660](../../decisions/660-tool-call-heartbeat.md).

## Increments

| # | Lane | Owner | Needs | What lands |
| - | ---- | ----- | ----- | ---------- |
| 0 | `01M597Z3K6K0KN8FZRVYWVG3K5` | miley | — | ADR 660 (landed, #2883), this spec and plan |
| 1 | `01M5AJ8VRNF9EX64BMKG8XX6D1` | open (platform) | 0 | `SeatPulseFrame` in `WSServerFrame`; `foldPulseKind`, `projectPulse`; SPEC A.25; `02-protocol.md` line; ADR 660 Consequences note (Tasks 1–2) |
| 2 | `01M5AJ99T6M9QTC41S566AKEX7` | open (platform) | 1 | `SeatPulses` on `ctx`; fed from `/trace/events`; 5 s coalescer; `broadcastFirehose`; snapshot on subscribe; scrub test (Tasks 3–5) |
| 3 | `01M5AJ9T16RPKV2M20Z20HA4HG` | miley | 1 (2 to see it) | `onPulse` in the client and `useLiveStream`; `OfficeHandle.pulse`; typing, screen life, bloom and `living()` follow the pulse (Tasks 6–9) |

Lane 3 can be built against lane 1's types with a dev-preview stub before lane 2 lands; it is only
_seen_ live once 2 is on the daemon. `test` kind is a later lane (spec §3.4), not in this plan.

## Global constraints

- Hard rule 1: any `packages/protocol/src` change must touch an ADR file in the same diff. ADR 660 is
  accepted, so its `## Decision` is frozen; the touch is a dated note in `## Consequences`.
- The frame carries exactly `type, member, ts, intensity, kind, last_ts`. No tool name, path, command,
  session digest, harness or agent id anywhere in a frame, log line or fixture.
- `PULSE_WINDOW_MS = 60_000`, `PULSE_MIN_GAP_MS = 5_000` (server), `PULSE_TTL_MS = 15_000` (web).
- Only `PostToolUse` and `PostToolUseFailure` rows **with a `tool_use_id`** count; distinct per
  `tool_use_id`. `HookOutcome` and transcript-tail kinds never count.
- No "intensity 0" frame is ever sent. Silence is the idle signal.
- `heartbeat` is the existing client→server presence frame. The new frame is `seat_pulse`; the word in
  copy and code is "pulse".
- No new runtime dependency. No new `setInterval` in the web package; liveness is read from `ts` in the
  rAF loop.
- `musterd/0.3` and `FEATURE_EPOCH` are not bumped: the frame is additive and view-only.
- Local gates only: `pnpm typecheck && pnpm lint && pnpm format:check`. Tests run in CI. A perf budget
  raise goes in the same PR with the number in `docs/perf/web-live-baseline.md`.

## Review focus

1. **A seat that fires ten tool calls in two seconds, then stops.** One pulse, five seconds after the
   first call, intensity 10; no second pulse; the desk is still 15 s after that pulse. Test in Task 4.
2. **Cursor posting two rows for one shell call** (`postToolUse` + `afterShellExecution`, same
   `tool_use_id`). Intensity counts 1. Test in Task 1 (`projectPulse`).
3. **A `broadcast`-grade viewer.** The frame it receives is byte-identical to the `full` one. Test in
   Task 5.
4. **A viewer opening `/live` mid-burst.** Sees the working desk on the first frame (snapshot), not
   after five seconds. Test in Task 5.
5. **A seat whose posture is `working` but has no pulse** (hooks off, or `MUSTERD_NO_TRACE=1`). Lit
   screen, typing amplitude 0, no bloom, and `living()` is false for it. Test in Task 7 and Task 8.

---

## Lane 1 — protocol

### Task 1: `foldPulseKind` and `projectPulse`

**Files:**
- Create: `packages/protocol/src/pulse.ts`, `packages/protocol/src/pulse.test.ts`
- Modify: `packages/protocol/src/index.ts` (export)

**Interfaces:**
- Consumes: `TRACE_TOOL_NAMESPACES`, `structuralToolName` from `./traceSync`; `HarnessId` from `./trace`.
- Produces:
  ```ts
  export const PULSE_WINDOW_MS = 60_000;
  export type PulseKind = 'read' | 'edit' | 'run' | 'test';
  export function foldPulseKind(harness: string, structuralName: string): PulseKind | null;
  export interface PulseInput { tool_use_id: string; ts: number; kind: PulseKind | null }
  export interface Pulse { intensity: number; kind: PulseKind | null; last_ts: number }
  export function projectPulse(window: readonly PulseInput[], now: number): Pulse;
  ```

- [ ] **Step 1: Write the failing tests** in `pulse.test.ts`:
  - `foldPulseKind('claude-code','Read') === 'read'`; `('claude-code','Edit') === 'edit'`;
    `('claude-code','Bash') === 'run'`; `('codex','apply_patch') === 'edit'`;
    `('codex','exec_command') === 'run'`; `('cursor','Shell') === 'run'`; `('opencode','grep') === 'read'`;
    `('grok','write_file') === 'edit'`.
  - `foldPulseKind('claude-code','mcp__musterd__team_send') === null`; `('claude-code','other') === null`;
    `('claude-code','AskUserQuestion') === null`; unknown harness → `null`.
  - `foldPulseKind` never returns `'test'` for any name in any `TRACE_TOOL_NAMESPACES` entry (loop).
  - Every name in every `TRACE_TOOL_NAMESPACES` entry returns one of the four or `null` without throwing.
  - `projectPulse([], now)` → `{intensity:0, kind:null, last_ts:0}`.
  - Two inputs with the same `tool_use_id` → `intensity: 1` (review focus 2).
  - An input with `ts < now − 60_000` is excluded; one at exactly `now − 60_000` is included.
  - `kind` is the kind of the input with the greatest `ts` whose kind is non-null; `last_ts` is that
    input's `ts`. Three inputs `[read@1, null@3, edit@2]` → `kind:'edit', last_ts:2`.
- [ ] **Step 2: Run** `pnpm --filter @musterd/protocol test -- pulse` — fails: module not found.
- [ ] **Step 3: Implement.** The fold is a hand table of three `Set<string>` per harness
  (read / edit / run), built once from the names in `TRACE_TOOL_NAMESPACES`: claude-code read =
  Read, Glob, Grep, LS, WebFetch, WebSearch, TodoRead; edit = Edit, MultiEdit, Write, NotebookEdit;
  run = Bash, BashOutput, KillShell, Monitor, Agent, Task. codex edit = apply_patch; run = Bash,
  Shell, exec_command, write_stdin. cursor read = Read, Grep, Glob, Search, ListDir, WebFetch,
  WebSearch; edit = Write, Edit, Delete; run = Bash, Shell, Task. opencode read = read, glob, grep,
  list, webfetch, websearch; edit = write, edit, patch, multiedit; run = bash, task. grok read =
  read_file, glob, grep, list_dir, web_search, browse; edit = write_file, edit_file; run = bash.
  Everything else → `null`.
- [ ] **Step 4: Run** the tests — pass. Export from `index.ts`.
- [ ] **Step 5: Commit** `protocol: foldPulseKind and projectPulse (lane 01M5AJ8VRNF9EX64BMKG8XX6D1)`.

### Task 2: `SeatPulseFrame`, SPEC A.25, docs, ADR note

**Files:**
- Modify: `packages/protocol/src/frames.ts:136-157` (after `LeaseFrame`, add to the union)
- Modify: `packages/protocol/src/frames.test.ts` (server-frame cases, around the `lease` test)
- Modify: `SPEC.md` (§5 Transport frame list at ~:101; new `## A.25` after `A.24` at ~:949)
- Modify: `docs/architecture/02-protocol.md:75-83` (one line after `presence`)
- Modify: `docs/decisions/660-tool-call-heartbeat.md` `## Consequences` (dated note)

**Interfaces:**
- Produces:
  ```ts
  export const PulseKindSchema = z.enum(['read', 'edit', 'run', 'test']);
  export const SeatPulseFrame = z.object({
    type: z.literal('seat_pulse'),
    member: z.string().min(1),
    ts: z.number().int().min(0),
    intensity: z.number().int().min(0),
    kind: PulseKindSchema.nullable(),
    last_ts: z.number().int().min(0),
  });
  export type SeatPulseFrame = z.infer<typeof SeatPulseFrame>;
  ```
  and `SeatPulseFrame` as the last member of `WSServerFrame`.

- [ ] **Step 1: Write the failing tests** in `frames.test.ts`:
  - `WSServerFrame.parse({type:'seat_pulse', member:'miley', ts:1, intensity:3, kind:'run', last_ts:1})` succeeds.
  - `kind: null` parses; `kind: 'bash'` fails; `intensity: -1` fails; `intensity: 1.5` fails.
  - A frame with an extra `tool_name` key: `WSServerFrame.strict` is not how the union is built, so
    assert instead that `Object.keys(SeatPulseFrame.shape)` deep-equals
    `['type','member','ts','intensity','kind','last_ts']` — the leak-surface pin.
- [ ] **Step 2: Run** `pnpm --filter @musterd/protocol test -- frames` — fails.
- [ ] **Step 3: Implement** the schema and add it to the union. Doc comment: "ADR 660: a seat's
  harness tool-call cadence, counts and kinds only; sent only to `team-all` subscribers, never on the
  seat's own connection; no frame means idle."
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: SPEC.md.** In §5's frame list add `seat_pulse`. Add `## A.25 Seat pulse (unreleased —
  ADR 660)` with the JSON shape, the four kinds, the 60 s window, the ≥5 s gap, "no frame when idle",
  and "additive to `musterd/0.3`".
- [ ] **Step 6: `02-protocol.md`.** One list line: Server → `seat_pulse`: `{ "type":"seat_pulse",
  "member", "ts", "intensity", "kind", "last_ts" }` — ADR 660, to firehose subscribers only.
- [ ] **Step 7: ADR 660 Consequences.** Append: `- _2026-MM-DD (lane 01M5AJ8VRNF9EX64BMKG8XX6D1):_
  the frame is \`seat_pulse\` (\`heartbeat\` was taken by the client presence frame); schema in SPEC
  A.25. \`test\` is in the enum but no fold produces it yet — spec §3.4.`
- [ ] **Step 8: Gates** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm -s change-adr:check`.
- [ ] **Step 9: Commit** `protocol: seat_pulse server frame, SPEC A.25 (lane 01M5AJ8VRNF9EX64BMKG8XX6D1)`.
  PR body first line: `Lane \`01M5AJ8VRNF9EX64BMKG8XX6D1\`.`

---

## Lane 2 — daemon

### Task 3: `SeatPulses` module (pure timing, injectable clock)

**Files:**
- Create: `packages/server/src/transport/seatPulses.ts`, `packages/server/src/transport/seatPulses.test.ts`
- Modify: `packages/server/src/context.ts:11-12` (add `pulses: SeatPulses`), `packages/server/src/index.ts`
  (construct it beside `hub`), `docs/architecture/03-server.md` file tree (described line)

**Interfaces:**
- Consumes: `projectPulse`, `foldPulseKind`, `PulseInput`, `SeatPulseFrame`, `PULSE_WINDOW_MS` from
  `@musterd/protocol`; `TraceEvent` from `@musterd/protocol`.
- Produces:
  ```ts
  export const PULSE_MIN_GAP_MS = 5_000;
  export interface SeatPulsesDeps {
    now: () => number;
    schedule: (fn: () => void, ms: number) => () => void; // returns cancel
    push: (teamId: string, frame: SeatPulseFrame) => void;
  }
  export class SeatPulses {
    constructor(deps: SeatPulsesDeps);
    feed(teamId: string, seat: string, events: readonly TraceEvent[]): void;
    snapshot(teamId: string): SeatPulseFrame[];   // one frame per seat with a non-empty ring
    dispose(): void;                                // cancel every timer
  }
  ```

- [ ] **Step 1: Write the failing tests** with a fake clock and a captured `schedule`:
  - `feed` with one `PostToolUse` (`tool_use_id:'a'`, `tool_name:'Bash'`, `harness:'claude-code'`)
    schedules exactly one callback at `5_000`; nothing pushed yet.
  - Firing it pushes one frame `{type:'seat_pulse', member:'miley', intensity:1, kind:'run'}` with
    `ts === now()` and `last_ts === event.ts`.
  - Ten events over 2 s before the timer fires → one frame, `intensity:10` (review focus 1); after
    the fire, no further timer is armed until the next `feed`.
  - A `feed` after the fire re-arms one timer.
  - Events of kind `HookOutcome`, `usage`, `SessionStart`, and a `PostToolUse` **without**
    `tool_use_id` are ignored: no timer, `snapshot` empty.
  - `PostToolUseFailure` counts.
  - `snapshot(team)` after a fire returns the seat's current projection; after `now` advances past
    `PULSE_WINDOW_MS` with no feed, `snapshot` is `[]` (ring trimmed and seat dropped).
  - Two teams, same seat name, are independent.
  - `dispose()` cancels an armed timer (the cancel function was called).
- [ ] **Step 2: Run** `pnpm --filter @musterd/server test -- seatPulses` — fails.
- [ ] **Step 3: Implement.** `Map<string /*teamId*/, Map<string /*seat*/, {ring: PulseInput[]; cancel: (() => void) | null}>>`.
  `feed` filters kinds, maps each to `PulseInput` via `foldPulseKind(ev.harness, ev.tool_name ?? 'other')`,
  appends, trims to the window, arms the timer if none. On fire: trim, `projectPulse`, push if
  `intensity > 0`, clear `cancel`. `snapshot` trims each ring, drops empties, projects the rest.
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Wire** `ctx.pulses = new SeatPulses({ now: Date.now, schedule: (fn, ms) => { const t =
  setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); }, push: (teamId, f) =>
  hub.broadcastFirehose(teamId, f) })` in `index.ts`; add `pulses` to the context type; call
  `dispose()` on shutdown next to the hub's teardown.
- [ ] **Step 6: Commit** `server: SeatPulses projection (lane 01M5AJ99T6M9QTC41S566AKEX7)`.

### Task 4: feed from `/trace/events`

**Files:**
- Modify: `packages/server/src/transport/http.ts:7381-7390` (after `ingestTraceEvents` returns)
- Test: `packages/server/src/transport/http.test.ts` or the existing trace-ingest integration test
  (find it with `grep -rln "trace/events" packages/server/src --include=*.test.ts`)

- [ ] **Step 1: Write the failing test:** POST one `PostToolUse` batch as a seat; with a fake
  `ctx.pulses` (or spying `feed`), assert `feed(team.id, member.name, body.events)` was called once
  with the parsed events. A batch of only `usage` rows still calls `feed` (the module filters) — so
  the handler stays one line and the filtering has one home.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement:** `ctx.pulses.feed(team.id, member.name, body.events);` immediately after
  the `ingestTraceEvents` call. Not on the `/sync/trace` path (spec §3.2 rule 1); add a one-line
  comment there saying so and citing ADR 660.
- [ ] **Step 4: Run** — pass. **Commit** `server: /trace/events feeds SeatPulses (lane 01M5AJ99T6M9QTC41S566AKEX7)`.

### Task 5: snapshot on subscribe; the scrub is identity

**Files:**
- Modify: `packages/server/src/transport/ws.ts:1079-1101` (`case 'subscribe'`, after `subscribeFirehose`)
- Modify: `packages/server/src/transport/broadcastScrub.test.ts`
- Test: the ws integration test that covers `subscribe team-all` (`grep -rln "team-all" packages/server/src --include=*.test.ts`)

- [ ] **Step 1: Write the failing tests:**
  - ws: with a seat whose ring is non-empty, a new `subscribe team-all` connection receives
    `subscribed` and then one `seat_pulse` for that seat (review focus 4); a connection with
    `visibility: 'broadcast'` receives the same bytes as a `full` one (review focus 3).
  - scrub: `scrubForBroadcast(frame)` deep-equals `frame` for a `seat_pulse` whose `member` is
    `'mskey_lookalike'` — the member name is the only string, and a real credential never is one.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement:** after `send(ws, { type: 'subscribed', … })` and only for `team-all`:
  `for (const f of ctx.pulses.snapshot(conn.teamId)) send(ws, scrubForReader(conn.visibility ?? 'public', f));`
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: `03-server.md`:** under the WS section, one paragraph: the pulse's source, gap,
  silence-is-idle, snapshot on subscribe, and the sync-path gap.
- [ ] **Step 6: Gates, commit** `server: seat_pulse snapshot on subscribe (lane 01M5AJ99T6M9QTC41S566AKEX7)`.
  PR body first line: `Lane \`01M5AJ99T6M9QTC41S566AKEX7\`.`

---

## Lane 3 — the desk

### Task 6: the pulse reaches `OfficeScene`

**Files:**
- Create: `packages/web/src/live/pulse.ts`, `packages/web/src/live/pulse.test.ts`
- Modify: `packages/web/src/live/client.ts:810-815` (`LiveHandlers`), `:891` (new `case 'seat_pulse'`)
- Modify: `packages/web/src/live/useLiveStream.ts:30-40` (`LiveState.pulses`), `:208` (handler)
- Modify: `packages/web/src/live/OfficeScene.tsx` (prop `pulses`, effect calling `handle.pulse`)
- Modify: `packages/web/src/live/office-scene/types.ts:310` (`OfficeHandle.pulse`), `:14` (`OfficeNode.pulse?`)
- Modify: `packages/web/src/routes/live.tsx:712`, `packages/web/src/routes/broadcast.tsx:334` (pass `pulses`)

**Interfaces:**
- Consumes: `SeatPulseFrame`, `PulseKind` types from `@musterd/protocol`.
- Produces:
  ```ts
  // pulse.ts
  export const PULSE_TTL_MS = 15_000;
  export type SeatPulse = Pick<SeatPulseFrame, 'ts' | 'intensity' | 'kind' | 'last_ts'>;
  export function pulseIntensity(p: SeatPulse | undefined, now: number): number; // 0 after TTL
  export function pulseLive(p: SeatPulse | undefined, now: number): boolean;
  export function runGlow(p: SeatPulse | undefined, now: number): number;        // 1→0 over 3 s from last_ts when kind==='run', else 0
  // types.ts
  OfficeHandle.pulse: (member: string, p: SeatPulse) => void;
  OfficeNode.pulse?: SeatPulse;
  // useLiveStream
  LiveState.pulses: ReadonlyMap<string, SeatPulse>;
  ```

- [ ] **Step 1: Write the failing tests** in `pulse.test.ts`:
  `pulseIntensity({ts:0,intensity:4,…}, 14_999) === 4`; at `15_000` → `0`; `undefined` → `0`;
  `pulseLive` mirrors that; `runGlow` is `1` at `last_ts`, `0.5` at `+1_500`, `0` at `+3_000` and
  for `kind:'edit'`.
- [ ] **Step 2: Run** `pnpm --filter @musterd/web test -- pulse` — fails.
- [ ] **Step 3: Implement** `pulse.ts`. Client: `onPulse: (p: SeatPulseFrame) => void` in
  `LiveHandlers`; `case 'seat_pulse': this.h.onPulse(frame); break;`. `useLiveStream`: a
  `useState<Map<string, SeatPulse>>`, replaced per frame (new Map, set member). `OfficeScene`: a
  `pulses` prop; an effect that, for each changed entry, calls `handle.pulse(member, p)` (keep a ref
  of the last map, call only for entries whose `ts` changed). `index.ts`: `pulse(member, p)` sets
  `node.pulse` on the named `OfficeNode` and marks the scene dirty.
- [ ] **Step 4: Run** — pass; `pnpm typecheck`.
- [ ] **Step 5: Commit** `web: seat_pulse reaches the office (lane 01M5AJ9T16RPKV2M20Z20HA4HG)`.

### Task 7: typing follows the pulse

**Files:**
- Modify: `packages/web/src/live/office-scene/skeleton.ts:304` (add `typingFromPulse` beside `typingBurst`)
- Modify: `packages/web/src/live/office-scene/render.ts:3183` (`skelFor`'s `typing`)
- Test: `packages/web/src/live/office-scene/skeleton.test.ts`

**Interfaces:**
- Produces: `export function typingFromPulse(intensity: number, seed: number, t: number): number` — 0
  when `intensity === 0`; otherwise a phase-seeded burst whose duty cycle is
  `clamp(0.25 + 0.6 * (intensity − 1) / 11, 0.25, 0.85)` of a 6 s period, ramped like `typingBurst`.

- [ ] **Step 1: Write the failing tests:** `typingFromPulse(0, s, t) === 0` for 100 sampled `t`;
  for `intensity 1`, the fraction of sampled `t` over one period with value `> 0` is within 0.05 of
  0.25; for `intensity 12`, within 0.05 of 0.85; two seeds at the same `t` differ in phase (not
  equal for most samples).
- [ ] **Step 2: Run** — fails. **Step 3: Implement.**
- [ ] **Step 4: Change `skelFor`:** `const typing = pose.sit > 0.9 && pose.gesture === 0 ?
  typingFromPulse(pulseIntensity(node.pulse, nowMs), seed, t) : 0;` — posture no longer gates it
  (review focus 5). `nowMs` is the frame's wall clock already threaded to the renderer; if only `t`
  (seconds since mount) is available, add `nowMs` to the render context in the same commit.
  The receptionist's `typingBurst` at `:1892` stays: she is not a seat.
- [ ] **Step 5: Run** the office-scene tests — pass. **Commit** `office: typing follows the pulse (lane 01M5AJ9T16RPKV2M20Z20HA4HG)`.

### Task 8: screen life, bloom, room tone and loop parking follow the pulse

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts:3569-3650` (`screenPanel` gains `alive: boolean`, `glow: number`)
- Modify: `packages/web/src/live/office-scene/render.ts` `drawWorkstation` call site (pass `alive`, `glow` from the node's pulse)
- Modify: `packages/web/src/live/office-scene/index.ts:2095` (`living()`), `:2317-2337` (room tone)
- Test: `packages/web/src/live/office-scene/index.test.ts` or the recording-ctx render test

- [ ] **Step 1: Write the failing tests:**
  - `living()` with one node `posture:'working'`, seated, `pulse` undefined → `false`; with a live
    pulse → `true`; with a pulse older than `PULSE_TTL_MS` → `false` (review focus 5).
  - Render with the recording context: a seated working node with no pulse draws `SCREEN_IDLE`-free
    lit panel (the static lit desktop) and **no** `'lighter'` composite op; with a live pulse the
    `'lighter'` op appears; with `kind:'run'` at `last_ts = now` the bloom alpha is higher than with
    `kind:'edit'` (assert on the recorded fill style alpha, or on a `glow` argument spy).
  - Room tone's `working[]` excludes the no-pulse node.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** In `screenPanel`: `working` keeps the screen lit but draws a **static**
  desktop (call `drawScreenLife` with a fixed `t`, e.g. `0`) when `!alive`; `alive` draws it animated
  and enables the bloom branch; `glow` scales the bloom alpha `base * (1 + 1.5 * glow)`.
  `drawWorkstation` passes `alive = pulseLive(node.pulse, nowMs)`, `glow = runGlow(node.pulse, nowMs)`.
  `living()` returns true if any node has `pulseLive`, or is mid-walk as today; `workingAtDesk` is no
  longer sufficient on its own. Room tone collects `pulseIntensity > 0` seats.
- [ ] **Step 4: Run** — pass. Check the dev preview (`pnpm dev`, `/live`) by eye with a stub pulse
  from the console.
- [ ] **Step 5: Commit** `office: screen life, bloom and parking follow the pulse (lane 01M5AJ9T16RPKV2M20Z20HA4HG)`.

### Task 9: docs, budget, ship

**Files:**
- Modify: `docs/architecture/08-web.md` (one bullet under the office scene: the pulse replaces the
  posture-seeded typing loop, ADR 660; `pulse.ts` described line in the file tree)
- Modify if needed: `docs/perf/budgets.json`, `docs/perf/web-live-baseline.md`

- [ ] **Step 1:** `pnpm --filter @musterd/web build && pnpm -s perf:check`. If over, raise the one
  budget by the measured delta plus 200 B and record the number and lane in `web-live-baseline.md`.
- [ ] **Step 2:** Gates: `pnpm typecheck && pnpm lint && pnpm format:check`.
- [ ] **Step 3: Commit, PR** with `Lane \`01M5AJ9T16RPKV2M20Z20HA4HG\`.` on its first line;
  `gh pr merge --squash --auto --delete-branch`; after merge `lane_submit` and follow its reply.
- [ ] **Step 4: Acceptance** (spec §6): with lane 2 on the daemon, watch one Claude Code seat
  heads-down on `/broadcast` for twenty minutes and one seat with `MUSTERD_NO_TRACE=1`; note both in
  the lane's submit body.

## What this plan leaves out, on purpose

- `test` kind (spec §3.4): its own lane with a client-side `detail.run_class` classifier.
- Pulses for seats on other nodes (`/sync/trace`): stated in ADR 660 Consequences by lane 2.
- Any replay of pulses on open: the subscribe snapshot is enough.
