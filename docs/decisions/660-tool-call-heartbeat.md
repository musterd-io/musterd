# 660 — Tool-call heartbeat: the office shows a seat is working, from counts and kinds only

- Status: accepted — 2026-10-19, nick ("approve the ADR, start the heartbeat lane"). Drafted
  2026-10-18 as a skeleton at his request, with nothing built until he had read it.
- Date: 2026-10-19
- Lane: `01M597Z3K6K0KN8FZRVYWVG3K5` (goal `live-delight`)
- Builds on: [ADR 445](445-agent-traces-captured-local-first.md) (harness tool calls already reach
  the daemon's `trace.db`, batched, local-first, research substrate),
  [ADR 184](184-dataset-consent-and-redaction.md) (emitted ≠ published),
  [ADR 151](151-web-perf-budgets-gate.md) (the `/live` perf budget), and ADR 445 §1's product
  boundary: musterd does not ship agent-internals observability.
- Brainstorm: whiteboard `broadcast-shipped-blocked`, miley + nick, 2026-10-18.

## Context

nick, watching `/broadcast` on 2026-10-18: the stream looks fake because things are "too sequenced"
and the members "aren't doing anything like saying any messages or acts or moving". The north star he
set for the stream: a stranger arriving mid-stream leaves saying _"this team is actually shipping real
work, right now."_

Measured the same day (`musterd inbox --all --json`, local time): 182 team acts, in three bursts —
87 in 09–11h, 61 in 15–17h, 21 at 21h — with six gaps longer than 15 minutes (466, 223, 175, 106, 76,
68 min). Only 36 of the 182 were directed at one member; 67 were machine lane envelopes
(`[lane] opened …`) and 54 were status lines. During the gaps the seats were building — branches
pushed, PRs merged — but the office draws a seat with no acts as a still figure at a desk.

The signal that a seat is working already exists on this machine. ADR 445's hooks fire on every
harness tool call (`PreToolUse` / `PostToolUse` on Claude Code; observers on Codex, Cursor, Grok) and
post batched events to the daemon within seconds, into `trace.db`. Nothing pushes any of it to the
room. The office animates **acts** only (`office-scene/mapping.ts`); a seat between acts has no
motion source.

Not to be confused with `tool_call_stats` (ADR 144): that counts musterd's **own** MCP tools
(`team_send`, `lane_board`, …) — 7,433 calls in the last 7 days — and says nothing about what a seat
is doing in its harness.

## Problem

ADR 445 drew a deliberate line: traces are research substrate, off by default for the product, and
"musterd does not ship agent-internals observability". Driving a product surface from trace data is
a scope change against that line, even when the surface shows no content. Without a decision here,
either the room stays still between acts (the stream reads as fake) or a seat quietly wires traces to
the viewer (the ADR 445 boundary erodes without a record).

The surface is also public: `/broadcast` streams to strangers. A filename, a command or a prompt
fragment from a hook is content, and content must never reach it.

## Decision

1. **A per-seat heartbeat, from counts and kinds only.** The daemon derives, per occupied seat, an
   _intensity_ (harness tool-call events per minute, from ADR 445's batches) and the _kind_ of the
   latest event, folded to four: `read`, `edit`, `run`, `test`. Never the body, the path, the
   command, or the tool name. This is a projection the daemon computes; `trace.db` content stays
   where ADR 445 left it.
2. **One pulse per seat, coalesced.** Pushed over the existing `/ws` stream to connected viewers at
   most every ~5 s per seat, so the heartbeat stays inside the ADR 151 budget and a chatty seat does
   not become a firehose. _(Frame shape: a protocol change — this ADR is the record it needs under
   hard rule 1; the exact schema is left to the lane's spec.)_
3. **The desk reacts; nothing is invented.** Typing cadence follows intensity; the monitor glows on a
   `run`; a `test` flashes once. No text appears. Every motion traces to a real event, and a seat
   whose harness has no hooks, or that is truly idle, stays still — honestly. No randomised timing,
   no fidget loop.
4. **ADR 184's line holds.** Counts and kinds are emitted to viewers of the team's own `/live`;
   nothing here publishes trace content, and the dataset-consent rules are untouched.

## Consequences

- A seat heads-down for 20 minutes with no acts visibly works on `/live` and `/broadcast`; a seat
  that is idle does not. That, and the gates, is the acceptance test.
- Coverage is uneven and shown as such: Claude Code's hook rail is complete; Codex and Cursor
  observers have gaps, so seats on those harnesses will look stiller. Papering over that would be the
  invented motion this ADR rules out.
- Platform work (the projection, the frame, the push) and designer work (the desk) share one lane
  with two halves; the platform half wants a platform seat.
- `docs/design/observability.md` §7's non-goal stands: this is not agent-internals observability.
  It shows _that_ a seat acts, at a cadence, and nothing of _what_.
- Sibling, not folded in: lane `01M4V74S9E2E72SV53HC1GPYA9` (what the stream does during a long
  quiet gap — a dated replay of the day's merges with the live clock showing).
- _2026-10-19 (lane `01M5AJ8VRNF9EX64BMKG8XX6D1`):_ the frame is `seat_pulse` — `heartbeat` was
  already the client→server presence frame — with exactly six fields `{type, member, ts,
  intensity, kind, last_ts}`, recorded in SPEC A.25 and pinned by a key-set test. The fold and the
  projection are pure functions in `@musterd/protocol` (`foldPulseKind`, `projectPulse`) so the
  daemon and the offline eval share one arithmetic. `test` is in the kind enum but nothing
  produces it: no structural trace row says a shell call was a test run, and the command text is
  content. A later lane adds a client-side classifier (`detail.run_class`) and amends here.
  Design: `docs/superpowers/specs/2026-10-19-tool-call-heartbeat-design.md`.
  Follows-up: deferred — the three heartbeat lanes landed and the desk seen moving (2026-10-19)
- _2026-10-19 (lane `01M5AQ1DDHFM4VMKPQQ534RTZ6`):_ seats on a joiner node pulse too. On
  2026-10-19 four of the ten working seats (ryder, lazara, slippy, dreamy) reached the hub only
  over `/sync/trace` (ADR 453) and pulsed nothing; the hub now feeds each seat's **admitted** rows
  into the same rings after `ingestSyncedTraceRows`, so a refused or held row never pulses. Their
  pulses run up to the trace push's 60 s cadence late, and a row older than the 60 s window by the
  time it lands counts for nothing: a joiner seat's desk moves in bursts, honestly late, rather
  than not at all.

## Observability & Evaluation

- **Traces:** the heartbeat pulses are counted per seat per hour (a `record`-kind projection, no new
  table of their own) so the viewer's cost can be read against the ADR 151 budget.
- **Eval:** before/after on the stream — for one day, the minutes a working seat (≥1 harness event in
  the minute) is drawn still. Baseline today: every minute without an act. Target: ~0 on a hooked
  harness.
- **Experiment:** n/a for the draft — the first judge is nick watching the stream.
