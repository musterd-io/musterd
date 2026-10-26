# 732 — A push also reaches the owner whose lane on the file just ended, and carries what changed

- Status: accepted
- Date: 2026-10-26
- Lane: `01M5WJJAMF` (goal `coordination-cost`), asked for by nick ("Option 2 sounds good")
- Amends: [731](731-push-reaches-covering-lanes.md) §1 (the covering audience) — §2 and §3 stand;
  [730](730-push-is-an-event.md) §1 (the push report gains two optional fields)
- Extends: [691](691-named-file-is-held-first-claim-wins.md), [724](724-held-refusal-watches-the-holders-lane.md)

## Context

ADR 731 made the audience of a recorded push every seat whose contending lane covers a file the pushing
lane names, and told the pusher who had heard. [Finding 027](../research/027-cooperbench-rider5-run.md)
measured it on CooperBench's 10 `core` pairs: 12 of 22 recorded pushes fired an act, every one to the
covering partner, and the receiver fetched or merged 10 times. The 10 pushes that fired nothing all
have one shape. The first mover finished, resolved (8), released (1 lane, 2 pushes) or handed off (1)
its lane, and *then* the second mover edited and pushed. By then no contending lane covered the file, so
the audience was empty by construction. The finished partner was not finished with the branch: in 7 of
those 10 pairs it went on to merge the second mover's branch and write the combined patch, having
learned of the push by a hand-sent message or by polling. ADR 731 also read a narrower contending set
than the protocol's — claimed, active, blocked — so a partner that had submitted and was awaiting
acceptance heard nothing either.

The same finding read the pusher's side. The hook's line reached the pusher 22 of 22 times, and 8 of
the 12 announced pushers still sent a message. Every one of the eight opened with what they had
changed — "I added hex_str, uuid4 and ipv4 after the whitespace line", "HandleFunc now parses HTTP
methods like Handle does" — then what the partner may now do. The push act carries the branch, head
and paths and nothing about the work. The line told the pusher the push had been announced; the
message the pusher wanted to send was never only "I pushed".

Where rider 5's $18.54 went: 128 `team_inbox_check` calls ($2.90, 82 of them in wait mode), 60
`ToolSearch` calls ($1.17), 28 edit refusals ($0.78), 12 "pushed / fetch" sends ($0.25). The partner
waiting to merge polls because nothing reaches it.

## Problem

Put the push act in front of the partner who has finished and is waiting to merge, without reopening
the `@team` noise ADR 726 took out, and give the act the one sentence the pusher would otherwise write
by hand — written by git, not by a model turn.

## Decision

1. **A lane's interest in a file outlives the lane, for a while.** The covering audience (ADR 731 §1)
   is read over the protocol's contending set (`LANE_CONTENDING_STATES`: claimed, active, blocked,
   awaiting acceptance, ready for review) **and** over lanes that have left it — done, abandoned, parked,
   or reopened — within the team's `push_audience_ended_lane_window_ms` of the push, by `resolved_at`
   for a closed lane and `updated_at` otherwise, when the lane still has an owner on record. A released
   lane has none and is out. Same project, never the pusher, never an unowned lane, named files only, as
   before. The window is a team policy knob (`PolicySchema`), default 30 minutes
   (`PUSH_AUDIENCE_ENDED_LANE_WINDOW_MS`), 0 to turn it off, at most 24 hours. The pusher's own lane is
   still found among claimed, active and blocked lanes (ADR 730 §2) — nothing changes about whose push
   is recorded. `lane_push_recorded` logs `ended`: the seats in the audience only by this rule.
2. **The push report carries what changed, and the act reads it out.** `LanePushReport` gains two
   optional fields, `subjects` (at most 5, each at most 120 characters) and `files` (at most 20). `gate
   record-push` fills them from git after a recorded push: the remote-tracking ref's reflog holds where
   the remote *was* (`refs/remotes/<remote>/<branch>@{1}`, written by the push that just moved it), so
   when that value is an ancestor of HEAD the range is exact — the commit subjects newest first and the
   files `git diff --name-only` names between them. On a first push, or a force that moved the ref off
   history, the last five commits at HEAD and their files. The act body becomes `[lane] <seat> pushed
   "<title>": <branch> at <head> on <remote> — <subject>; <subject> (files: a, b) — fetch it before you
   edit …`, the clause absent when the report carried nothing; `meta.lane_pushed` gains `subjects` and
   `files` when present. The hook command text does not change.
3. **Nothing else changes.** ADR 731 §2 (the pusher's line) and §3 (the head in the refusal) stand;
   `until_lane` does not wake on a push (ADR 730 §4); the repeat-head rule holds; ADR 724's freed act is
   as it was. No new act type: the pusher writes nothing.

### Rejected

- **An act the pusher writes ("what changed").** The pusher already writes it, by hand, once per
  hand-off, at $0.02. A new act would move the same model turn behind a tool name. Git has the sentence.
- **Replaying the push act at the partner's lane close.** The partner who finishes first is the one who
  merges; it needs the push at the push, not a replay at its own close.
- **Counting ended lanes without a window.** A lane that covered a file last week is a stale interest;
  the window is the task's life, and a knob.
- **Waking `until_lane` on the push.** ADR 730 §4's reason stands: the waiter asked for a lane state.
  The push act is a directed act, so a seat in `team_inbox_check {wait}` returns on it already — which is
  what R6b of rider 6 measures.

## Consequences

- An owner whose lane on a file just ended hears one act per new head for 30 minutes after. On a real
  team that is the reviewer or merger of a branch; on CooperBench it is the partner waiting to merge.
- Two optional fields on an HTTP body the hook alone sends; a schema change under this ADR (hard rule
  1). Older hooks send the bare report and the body keeps its ADR 731 shape.
- Two to three more git reads per recorded push (reflog, log, diff), on the hook's side only.
- One more board read per recorded push when the window is on (ended lanes, filtered in memory by
  time); none when it is 0.
- `hold_smoke.py` and `gate_smoke.py` are unaffected: neither pushes.
- The `lanePush.ts` line in `docs/architecture/03-server.md` was held by big-body's lane `01M5N55GVE`
  (ADR 691); big-body cleared the one-line edit in session on 2026-10-26, so it lands with this ADR.

## Observability & Evaluation

- **Traces.** `lane_push_recorded {watchers, covering, ended, repeat}`, `lane_push_fired {seat, lane}`
  as before; the act is the record (`meta.lane_pushed`, now with `subjects` and `files`).
- **Eval.** Server tests (`gate-http.test.ts`): a lane that covered the file and resolved minutes ago
  is told, one that ended hours ago is not; a parked lane counts by its last change; a released lane is
  out; the window at 0 turns the rule off; a partner awaiting acceptance is told; the body and meta
  carry the subjects and files. CLI tests (`gate.push.test.ts`): `pushChanges` reads the pushed commits
  on a first push and exactly the moved-over range on the next, caps at five and twenty, and says
  nothing for a repo it cannot read. Protocol test: the report parses bare and full, and refuses over
  the caps.
- **Experiment.** [Rider 6](../research/cooperbench/riders.md#rider-6-finding-027s-remainder--the-push-reaches-the-partner-whose-lane-just-ended-and-carries-what-changed),
  pre-registered 2026-10-26 (#3330) before this ADR landed: on the next musterd CooperBench run on a
  build carrying it, over the 10 `core` pairs — R6a recorded pushes that fired an act from 12 of 22:
  ≥ 90% acted, ≤ 70% did not; R6b `team_inbox_check` calls in wait mode from 82: ≤ 55 acted, ≥ 75 did
  not; R6c announced pushers who repeated by hand from 8 of 12: ≤ 25% acted, ≥ 60% did not. Run manifest
  [rider6-manifest.md](../research/cooperbench/rider6-manifest.md); the run is lane `01M5WJJGNJ`.
