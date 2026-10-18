# Lane write refused: "changed since it was read"

When every `lane_submit` and `lane_update` on a lane is refused with "changed since it was read — now owned by …" while `lane_board` shows the lane in a different state, the hub's row and your local row disagree, and retrying the same write does not help.

## What the refusal means

The wording "changed since it was read" comes from hub arbitration (`sync/claim.ts`), not the local write path, which says "changed while this update was being decided" instead. Getting the first wording means the hub already holds a different state for the lane than the one you read. `lane_board` and `team_next` both serve the local row, so the two agreeing with each other does not show the hub agrees. See [sync push](sync-push.md) for the joiner write path.

## Sightings

A `lane_submit` from a joiner committed its state on the hub, then failed to mint the acceptance ask. Every retry was refused "changed since it was read — owned by delta (awaiting_acceptance)" while the board kept printing the lane active (2026-09-15, delta, lane 01M2GBGA03; falsify: a retry on that lane accepted between the failed submit and the hand-routed acceptance). <!-- claim: defect -->

A joiner's pull cursor pinned at hub_seq 163905 behind a mistagged ledger verb, so every later arbitrated write was refused with the same wording. It was fixed by #2052 (711bf12a): a joiner on the fixed build advances on its next tick (2026-10-04, dreamy; falsify: `sync_pull_cursor.last_hub_seq` advancing past 163906 before 711bf12a landed). <!-- claim: defect -->

After sloane set lane 01M4F0S6KP back to active (`merged: null` + `state: active`) following a submit, every `lane_submit` (MCP and CLI) and `lane_update` from sloane was refused "now owned by sloane (awaiting_acceptance)" while `lane_board` showed it active. Nothing was fixed. ghost's decline moved the lane to active 41 min later, and sloane's resubmit 6 min after that went through: 47 min 20 s wedged in total (2026-10-17, sloane, #2799 then #2813; falsify: a state change by sloane on that lane between 1792272614482 and 1792275100889 ms). <!-- claim: defect -->

## What to do

- Read the refusal's middle. "Since it was read" means hub arbitration, so check the hub's view of the lane, not the board's.
- Do not retry the same write more than twice. Each retry meets the same hub row.
- If the merge evidence exists (PR, squash SHA), route the acceptance by hand with `request_help` to 2–4 candidate acceptors, as ADR 348 allows, and say no ask was minted.
- On a joiner, compare `sync_pull_cursor.last_hub_seq` against the hub's `/health` and tail `daemon.err.log` for a `sync_fold_*` line. A pinned cursor is a sync defect, not a lane one.
- A write by another seat on the lane (an acceptor's decline, a re-route) can bring the two rows back into line. Once that happens, your next write goes through.
