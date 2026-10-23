# 724 — A held-file refusal watches the holder's lane

- Status: accepted
- Date: 2026-10-23
- Lane: `01M5N3THX3` (goal `coordination-cost`), asked for by nick
- Extends: [691](691-named-file-is-held-first-claim-wins.md) §3, [705](705-mcp-inbox-blocking-wait.md)

## Context

When a seat is refused an edit because another seat's lane holds the file (ADR 691), it has to
find out when the file is free. ADR 705's `team_inbox_check {wait, until_lane}` does that in one
call, and #3219 made the refusal lead with it. It did not change behaviour: after the new text,
the lane wait came next in 2 of 11 held refusals, against 2 of 29 before
([finding 024](../research/024-cooperbench-rider-run.md)). Agents deep in a real feature ask the
holder instead, and the holder then spends a message saying "done, pushed, you can edit"
([finding 022](../research/022-cooperbench-coordination-residue.md): 34 such sends on CooperBench
`core`). The board reads behind them are about a fifth of all board reads (finding 022 follow-up,
lane `01M5N3SR7H`: 21 of 100 on `core` were "who holds it" or "is my partner done").

The pieces are already there. Every held refusal is recorded per seat on the refusing daemon
(`gate_hold_refusals`, ADR 697: seat, path, holder, holder lane). What is missing is the other end.
Today a lane's end reaches the refused seat only as the `@team` `lane_resolve` broadcast. It is not
directed, so a plain blocking wait (`onDirected`) never wakes on it, and the inbox folds it as
ambient. It carries no branch. Release and handoff send no `lane_resolve` at all.

## Problem

Tell the refused seat when the file it was refused becomes free, with the work it needs to bring
in, whatever the seat did after the refusal: waited with or without a lane, messaged the holder, or
went on with something else. Do it without a new tool, without a protocol schema change, and
without relying on the agent to pick the right call.

## Decision

1. **A held refusal opens a watch.** When Gate A refuses (or, under `warn`, warns) a seat because
   another seat's lane holds the path, the refusing daemon records a watch next to the
   `gate_hold_refusals` row: (team, watching seat, holder lane, path). It is daemon-local, like that
   table and for the same reason: the gate that refused is the one that knows. One watch per
   (seat, lane, path); a repeat refusal refreshes it.
2. **The file becoming free fires it.** The file is free of that lane when the lane leaves the
   contending states (done, abandoned, released), or when the path is no longer named in the
   lane's scope. The daemon that holds the watch fires it on observing that change, whether its own
   write made it or the fold brought it from the hub, so a holder on another machine works the same.
   A **handoff does not fire it**: ADR 691 §2 moves the hold with the lane, so the file is still
   held, and the watch stays on the lane. _(Amended 2026-10-23: a handoff sends the watching seat a short notice that the hold moved — see Consequences.)_ An ADR 693 **lapse does not fire it** either: ADR 693 §2
   says a lapse is no new state and no act. The refused seat's next edit then meets the ADR 697
   hand-over, as today.
3. **One directed act per watching seat and lane.** The board seat (ADR 649) sends the watching seat
   an `act: 'message'`, directed, so it wakes any blocking wait and stays unfolded in the inbox:
   `[lane] <holder>'s lane "<title>" is <done|abandoned|released|no longer naming the file>: <path(s)>
   are free. Their work is on <branch> at <head> — bring it in before you edit.` The branch and head
   are the ones ADR 697 learned from the holder's edits. Without them, the sentence says no branch
   was seen. `meta.lane_freed` carries `{lane, holder, ended, paths, branch, head}`. Several watched
   paths in one lane make one act. The watches it answers are then removed.
4. **`until_lane` also wakes on it.** The MCP wait's `until_lane` check matches `meta.lane_freed` for
   its lane as well as `meta.lane_resolve`. That covers release, which today ends no `until_lane`
   wait.
5. **Bounds.** A watch whose lane has not freed the file within 7 days is dropped without a notice.
   A watch is not removed when the watching seat leaves. The act waits in its inbox for the next
   session, which is when it is needed.
6. **Nothing else changes.** The refusal text, the gate's outcomes and audit rows, ADR 697's
   one-time hand-over refusal, and the `@team` `lane_resolve` broadcast all stay as they are. The
   act rides the existing `message` envelope; `meta` is already an open record. No new tool, no
   `@musterd/protocol` schema change, no policy key.

### Rejected

- **Watch only when the refused seat then messages the holder.** It is narrower and depends on
  matching a message to a refusal. Watching on the refusal covers every next move, and costs one
  act to a seat that may already have moved on (nick, 2026-10-23).
- **Make the `@team` `lane_resolve` broadcast directed to everyone with a refusal on record.** It
  would still miss release and narrowing, and would still carry no branch.
- **Reword the refusal again.** Finding 024 measured that and found no change.

## Consequences

- A refused agent that messages the holder no longer needs the holder's "done, pushed" reply. The
  holder's state signal becomes redundant rather than forbidden; nothing tells the holder to stop.
- One more directed act per refused seat per freed lane. On CooperBench `core` that is at most one
  per held refusal (16 there), fewer after dedup per lane.
- `gate_hold_refusals` gains a sibling table, created by a ladder migration on the daemon only. It
  is not replicated.
- _2026-10-23 (big-body's review):_ the lane brief asked for a wake on handoff, and the Decision
  says a handoff does not fire the watch. Both were right about something. The file is still held
  after a handoff, so the "file is free" act would be false. But the refused seat may be waiting on
  a reply from the old owner, who no longer holds the lane. So a handoff sends a different directed
  act: `[lane] <old owner> handed "<title>" to <new owner>: <path(s)> are still held, now by <new
  owner>. Ask them, or wait on the lane.` It carries `meta.lane_hold_moved` `{lane, from, to, paths}`.
  The watch stays on the lane, and `until_lane` does not wake on this act: the file is not free.
- Build lane: `01M5N3TRZY`.

Follows-up: 01M5N3TRZY0TJ61TBM0NV1XJ2Z

## Observability & Evaluation

- **Traces.** A `lane.watch_fired` audit row on the watching daemon per act sent (actor: the board
  seat; target: the watching seat; detail: lane, ended, path count, whether a branch was known),
  and a `lane_watch_fired` info log line. A `lane_watch_dropped` log line for the 7-day bound.
- **Eval.** Server tests: a seat refused on a held file, in a plain `wait`, wakes with the branch
  when the holder resolves; a seat not waiting finds one unfolded directed act; release and
  narrowing fire; handoff and an ADR 693 lapse do not; two refused paths in one lane give one act;
  a fold-applied resolve fires on the joiner that holds the watch.
- **Experiment.** Rider 2 in [`riders.md`](../research/cooperbench/riders.md), pre-registered here,
  is read on the next musterd CooperBench run on a build carrying this ADR. Prediction: holder state
  signals ("pushed", "done", "you can edit") per pair with a held refusal fall from the claim run's
  rate. Falsify: they do not fall, or the refused agents still message the holder first in most
  refusals and then wait for its reply rather than the act.
