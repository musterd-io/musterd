# 731 — A push reaches the seats whose lanes cover its files, and the pusher is told

- Status: accepted
- Date: 2026-10-25
- Lane: `01M5V4H40C` (goal `coordination-cost`), asked for by nick ("audience 3, head addition in, run
  it — go ahead")
- Supersedes: [730](730-push-is-an-event.md) §3's audience, in part — the open ADR 724 watchers stay
  an audience; this ADR adds a second one. §1, §2, §4–§6 of ADR 730 stand.
- Extends: [691](691-named-file-is-held-first-claim-wins.md) (the refusal text),
  [724](724-held-refusal-watches-the-holders-lane.md)

## Context

ADR 730 made a push an event: the Bash PostToolUse hook reports a push of the lane's branch, the daemon
records it on the lane and sends one directed act to the seats waiting on that lane. It chose the
seats with an open ADR 724 watch — a held refusal not yet answered — as the audience, because that is a
recorded interest and not a guess, and left a wider audience to a later, measured decision.

[Finding 026](../research/026-cooperbench-rider4-run.md) measured it on CooperBench's 10 `core` pairs.
The hook reported 20 of 20 pushes and the daemon recorded every one. It announced **4**. The other 16
pushes had no seat watching the lane, for three reasons: the refused seat's own push has no watcher by
construction (10), the holder pushed before the partner was refused and the daemon does not replay a
recorded push to a watch that opens later (4), the holder pushed after the lane had freed the file and
the watch had closed (2). Hand-sent "pushed / fetch" messages rose from 14 to 18. And of the 4 holders
whose push the daemon did announce, 3 said it again by hand: the hook that reports the push tells the
pusher nothing, so a holder cannot know the partner has already heard.

What the daemon does know, at the push, with no refusal on record: which other lanes **cover a file
this lane names**. That is the gate's own relation — ADR 150's covering check decides whose edit a
path belongs to, ADR 691 holds a named file for the lane that named it first — so a seat in that set is
exactly a seat the gate would refuse for the file, and a seat that will need the branch to build on.
Unlike a glob-to-glob overlap (ADR 575: 27% of warned pairs ever touched a common file) it is anchored
on a concrete path one lane claimed outright. On the revive board the day of the decision, 35
contending owned lanes: 0 pairs name the same file across owners, 2 pairs have one owner's glob covering
a file another owner's lane names, 12 pairs overlap by glob.

## Problem

Put the push act in front of the seat that needs it, before any refusal and after the file frees,
without becoming the `@team` noise ADR 726 took out or the overlap guess ADR 575 stopped sending. Tell
the pusher what the daemon did, so a holder who pushed does not announce by hand what the partner has
already read. Give a seat refused after the push the place the work already is, so the gap between a
push and a later watch needs no replay. Change no instruction, no gate decision, and no hook command
text.

## Decision

1. **The audience adds the covering lanes.** For a recorded push (ADR 730 §2), the daemon tells, once
   per head, every seat with an open ADR 724 watch on the lane **and** every other seat that owns a
   contending lane (claimed, active, blocked) in the same project whose scope covers a file the pushing
   lane **names** _(Amended 2026-10-26: [ADR 732](732-push-reaches-ended-lanes-and-carries-what-changed.md)
   reads the protocol's contending set — awaiting acceptance and ready for review included — and also
   counts an owner whose covering lane left those states within the team's
   `push_audience_ended_lane_window_ms`; finding 027 found all 10 silent pushes behind this line.)_ (`isNamedFile`; covering by `pathGlobMatches`, the ADR 150 read). The pushing lane
   must name the file: an area glob says "I work around here" and would widen the audience to the
   glob-overlap set. Never the pusher, never an unowned lane, never a lane in another project (the
   `default` project contends with all, as everywhere). One act per seat per head carries the union of
   that seat's refused paths and covered files, sorted; the body says `… — fetch it before you edit;
   '<paths>' is still held.` for the files the pushing lane still holds (ADR 691, first claim) and
   `… — fetch it before you edit '<paths>'.` otherwise. `meta.lane_pushed` is unchanged in shape.
2. **The daemon answers with who was told; the hook reads it to the pusher.** `POST /lanes/push` returns
   `{lanes, acts, told}` (`LanePushOutcomeSchema`; `told` the seat names, sorted, once each). `musterd
   gate record-push` emits one PostToolUse `additionalContext` line (`hookSpecificOutput`, and
   `additional_context` for Cursor): when seats were told, `musterd: your push of <branch> at <head> on
   <remote> is recorded on your lane; <seats> was/were told to fetch it before editing the files your
   lane names — no need to say so by hand.`; when the lane has no audience, `… no other lane covers the
   files it names and nobody is waiting on it, so no one was told.`; nothing when no lane of the seat was
   on that branch or the daemon did not answer. The hook command text in `claudeCode.ts` does not
   change, so every seat's settings and the CooperBench arm's pinned copy are untouched.
3. **A refusal names where the branch already is.** When the ADR 691 held refusal is issued and the
   holder's lane has a recorded push, the detail (block and warn alike) ends with `Their branch <branch>
   is on <remote> at <head> — fetch it before you edit.` A seat refused after the push needs no replay of
   the act.
4. **Nothing else changes.** `until_lane` does not wake on a push (ADR 730 §4). The repeat-head rule
   holds: the same head sends nothing, a new head sends again. ADR 724's freed act, ADR 697's hand-over
   and the gate's decisions are as they were. The watch set stays an audience so a seat refused for a
   file the lane does not name (after a narrow) is still told.

### Rejected

- **Any glob overlap as the audience.** 12 lane pairs on today's board would get an act per push; ADR 575
  measured the relation at 27% precision and stopped sending it. The named-file anchor is what makes
  the covering set a recorded interest rather than a guess.
- **Only lanes that name the same file.** 0 pairs on today's board, and not every CooperBench refusal
  is in it: ADR 691 §3 refuses any seat whose edit hits a held file, named or merely covered. The gate's
  relation is covering, so the audience is too.
- **Replay a recorded push to a watch that opens later.** With the covering audience the partner heard
  at the push; for the remaining case the refusal text carries the head (§3), which is one read instead
  of a second act.
- **Tell the pusher by a directed act.** The pusher is the one seat that is certainly reading the hook's
  output at that moment; an act would land in an inbox it may not read before it writes the message by
  hand.

## Consequences

- On a real team an owner whose lane names a file now hears the hook's line on every push, one line;
  the seat covering that file hears one act per new head. On today's board that is cider, on big-body's
  pushes of a lane naming `packages/mobile/package.json`.
- `lane_push_recorded` logs `covering` beside `watchers`.
- One more read per recorded push (the board, filtered to contending lanes) and one `laneHoldingFile`
  per announced path.
- `hold_smoke.py` and `gate_smoke.py` are unaffected: neither pushes.
- _2026-10-26:_ [finding 027](../research/027-cooperbench-rider5-run.md) read this ADR on CooperBench:
  12 of 22 recorded pushes fired an act; the 10 that did not all came after the partner's lane had
  ended, and that partner merged. [ADR 732](732-push-reaches-ended-lanes-and-carries-what-changed.md)
  widens §1 to recently ended lanes and puts what changed into the act; §2 and §3 stand.
- _2026-10-25 (acceptance, this lane):_ the `lanePush.ts` line in `docs/architecture/03-server.md`
  landed one PR behind this one — big-body's lane `01M5N55GVE` held the file, cleared the line, then
  declined the first landing for it; the line now describes this ADR's audience and response.

## Observability & Evaluation

- **Traces.** `lane_push_recorded {watchers, covering, repeat}`, `lane_push_fired {seat, lane}` as ADR
  730; the act is the record (`meta.lane_pushed`). The hook's line is in the harness transcript, not
  logged by the daemon.
- **Eval.** Server tests (`gate-http.test.ts`): a seat whose lane covers the named file by glob is told
  before any refusal and named in `told`; a refused seat whose lane also covers the file is told once; the
  refused seat's own push reaches the holder with "fetch it before you edit '<paths>'." and no "still
  held"; a pushing lane that names nothing, an unowned lane, a lane in another project and the pusher
  itself are no audience; the same head again sends nothing; a refusal after the push carries the branch,
  remote and head. CLI test: `pushContextLine` for told / nobody / no lane / no answer. The ADR 730 tests
  stand with `told` added.
- **Experiment.** [Rider 5](../research/cooperbench/riders.md#rider-5-finding-026s-two-follow-ups--the-push-reaches-the-lanes-that-cover-its-files-and-the-pusher-is-told),
  pre-registered 2026-10-25 (#3318) before this ADR landed: on the next musterd CooperBench run on a
  build carrying it, over the 10 `core` pairs — R5a "pushed / fetch" sends from 18: ≤ 5 acted, ≥ 12 did
  not; R5b recorded pushes that fired an act from 4 of 20: ≥ 80% acted, ≤ 40% did not; R5c announced
  pushers who repeated by hand from 3 of 4: ≤ 25% acted, ≥ 60% did not. Run manifest
  [rider5-manifest.md](../research/cooperbench/rider5-manifest.md); the run is lane `01M5V4HH6Z`.
