# 493 — Huddle trace: one daemon-side timeline of a huddle

- Status: proposed
- Date: 2026-10-01
- Deciders: nick (asked for the view on the CLI and `/live`), izzo
- Lanes: `01M3WNKRPC` (CLI, izzo), `01M3WN919X` and `01M3WNPZ8K` (`/live`, miley)
- Relates to: ADR 128 (recipient scoping), ADR 254 (eligible sets), ADR 378 (huddles), ADR 386
  (convening wakes a named seat), ADR 445 (structural trace events)

## Context

On 2026-10-01 nick asked what happened in the demo rehearsal huddle `01M3WBAWCE`, end to end. izzo
answered with a per-seat timeline: the open and the steers, each seat's wake, the tool calls it made,
its turn in the room, and the close. It took five harness transcripts in four formats (Claude Code,
Codex, Grok, OpenCode) to build. The timeline showed why the room took 5.6 minutes: one seat's
checkout lacked the anchor file, and its two-minute `find` slowed every other seat's hooks. nick
asked for the same view in `musterd` and on `/live`.

The daemon already holds almost all of it:

- the huddle is a thread of Acts (`deriveHuddles`, ADR 378);
- wake facts are audit rows: `residency.wake_leased {lease_id, act}`, `residency.woke`,
  `residency.wake_failed` and `residency.wake_deferred` (with `act`, `session` fresh or resumed,
  `duration_ms` and `cost_usd`), and `residency.session_captured {session_digest, wake_lease}`;
- each tool call is a structural row in `trace_events` (ADR 445): seat, session digest, `ts`, `kind`,
  `tool_name`, `outcome` and `duration_ms`.

## Problem

Nothing joins these, and no route can read them for one huddle. `GET /audit` is admin-only and
cannot filter by Act. `GET /trace/seats/:name` returns only your own seat (admins see any), has no
time window, and stops at 200 rows. A client-side join would therefore need admin rights, hit the
row caps on a busy team, and be written twice, once in the CLI and once in `/live`, where the two
copies would drift.

## Decision

1. Add `GET /teams/:slug/huddles/:id/trace`. It answers `HuddleTraceSchema` (a new, additive schema
   in `@musterd/protocol`):
   - `huddle`: the `HuddleView`;
   - `seats`: one row per seat in the room, with:
     - `seat` and `harness`;
     - `summoned`: `opener`, `named`, `steered` or `joined`;
     - `summoned_at` and `summoned_by`;
     - `wake`: `null`, or `{lease_id, leased_at, spawned_at, session, outcome, duration_ms,
       cost_usd}`;
     - `first_turn_at` and `time_to_turn_ms`;
   - `events`: one merged, `ts`-sorted list of `{ts, seat, kind, label, act_id?, tool_name?,
     outcome?, duration_ms?}`, where `kind` is `act`, `wake`, `tool` or `session`.
2. The daemon assembles the answer from the records above. Wake rows join by `detail.act` in the
   huddle's thread. Tool rows are the seat's `trace_events` within the huddle's window, which runs
   from its open to its close, or to now while it is open, capped at two hours. Rows are selected by
   window, not by wake, so a seat attended in a visible terminal shows its steps too.
3. **Who may read it.** A Member in the huddle may read it: the opener, a named seat, a steered
   seat, or one that has taken a turn. So may a team admin. Anyone else gets the same 404 as a
   missing huddle (ADR 128: the route must not reveal that a huddle exists).
4. **What the trace may carry.** Tool events carry structure only: `kind`, `tool_name`, `outcome`
   and `duration_ms`. They never carry content or `detail`, whatever the team's `trace.content`
   policy is. This is the same limit as the seat timeline (ADR 445).
5. **Bounds.** At most 2,000 events. A truncated answer says so.
6. **Consumers.** `musterd huddle show <id> --trace` and `/live` render `seats` and `events` as
   given. Neither derives its own join.

## Consequences

- Wake and tool facts are readable for one huddle by the members of that huddle. Until now they
  could not read them, because only admins could. That is the intended scope widening, and it
  stops at the room.
- A seat with no trace hook (no `PreToolUse` tap) shows wake and turn rows but no tool steps. The
  gap is visible, not hidden.
- Host-only facts stay absent: the exit code and the woke latency are not persisted, so they are
  not in the trace.
- The route is additive. Older clients ignore it, and no existing schema changes.

## Observability

- Falsifier: a rehearsal huddle whose `--trace` output does not match the seats' own transcripts,
  either for the order of turns or for a seat's tool calls between its wake and its turn.
