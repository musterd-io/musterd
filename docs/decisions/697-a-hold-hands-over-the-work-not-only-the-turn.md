# 697 — A hold hands over the work, not only the turn

- Status: accepted (nick, 2026-10-21)
- Date: 2026-10-21
- Lane: 01M5G53AD62NHAPGVXZ5270Q5S (goal `cooperbench`)
- Amends: [ADR 691](691-named-file-is-held-first-claim-wins.md) (what the gate says when a hold
  ends); reads with [ADR 693](693-a-hold-lapses-when-its-holder-has-left.md) and
  [ADR 150](150-structural-inducement-pretooluse-gates.md)

## Context

ADR 691 made the first lane to name a file hold it, and under `block` the gate refuses another
seat's edit of it. [Finding 016](../research/016-cooperbench-pilot-2.md) measured that rule on
CooperBench's ten `core` pairs. The hold fired in every pair, and the refused agent asked its partner
for help and waited every time. Then, once the holder's lane closed, it edited **its own copy of the
base file**, without bringing in the change the holder had already pushed. Five of ten pairs still
ended in a merge conflict on that file. In both pairs that passed on the merged tree, both agents
had merged each other's branch; in every coordination loss, one agent never did.

So the hold turned a race into a queue, but the queue hands over only the turn. Nothing tells the
next seat that the file changed while it waited, or where the change is.

The same gap is on a real team. A seat that waits for a teammate's file and then edits from the
version it had before the wait produces the conflict the hold was meant to prevent, a little later.

nick's rule for the goal (2026-10-21): no gaming the bench; a gap it reveals is fixed in the product
for every team.

## Problem

When a hold ends, the gate goes from refusing the waiting seat's edit to allowing it quietly, as if
nothing happened. The seat gets no signal that the file has a newer version, and the daemon does not
know where that version lives: a lane's `branch` is set only when someone types it, and in finding
016 no agent did.

## Decision

1. **A lane learns its branch from the edits made in it.** The PreToolUse hook adds the editing
   seat's current git branch and `HEAD` commit to a contended-surface gate check (two optional
   fields on `GateCheckRequest`: `git_branch`, `git_head`). On an allowed edit inside a lane whose
   `branch` is empty, the daemon sets it to `git_branch`, and it keeps the latest `git_head` per lane.
   A lane that already names a branch keeps it. Neither field goes into the audit row (ADR 150's
   shapes-only rule); the lane carries the branch as it always could.
2. **The first edit after a hold ends is a hand-over.** When a seat whose edit of a file was refused
   because another seat held it (a `lane.gate` row with `hold = 'held'`, ADR 691) next edits that file
   and the hold is over (the holder's lane finished, narrowed, was handed off, or lapsed under ADR
   693), the gate does not pass the edit quietly. Under `block` it **refuses this one edit** with a new
   outcome, `denied_handover`. Under `warn` it allows it with the same text as an advisory. The reason
   names the holder, their lane and its state, the lane's branch and last-known commit, and the one
   thing to do: bring that work in (fetch and merge or rebase onto it), then edit again.
3. **One hand-over per seat, file and hold.** The next attempt at the same file is decided by ADR 691
   alone, as now. The daemon does not check whether the seat actually merged: it cannot see the
   seat's repository, and a refused edit followed by an informed choice is the inducement ADR 150
   builds on.
4. **No branch known, no guess.** If the holder's lane has no branch (the holder never edited through
   the gate, or its hook is older than this ADR), the reason says so and tells the seat to ask the
   holder where their change is. It never names a branch the daemon did not see.
5. **The rest is unchanged.** Areas, unnamed files, the holder's own edits, and claims are as in ADR
   691. No new policy key; posture is the team's, as before.

### Rejected

- **Check in the hook that the holder's commit is an ancestor of `HEAD` before allowing the edit.**
  Stronger, and it would stop a seat that ignores the hand-over. But it refuses a seat whose holder
  never pushed, needs a fetch inside a hook, and turns a one-line refusal into a git workflow the gate
  enforces. If the measure below shows hand-overs being read and ignored, this is the next step.
- **Merge or rebase the waiting seat's tree for it.** The gate never changes a seat's working tree.
- **Tell agents in the prompt to merge their partner's branch.** That is the bench-only instruction
  nick ruled out, and finding 015 already showed prose agreements do not hold.
- **Refuse the claim when a file is already held.** ADR 691 rejected it for the team's daily work;
  016 adds nothing that changes that.

## Consequences

- `@musterd/protocol`: `GateCheckRequest` gains optional `git_branch` and `git_head`, and
  `GATE_OUTCOMES` gains `denied_handover`. Older hooks send neither field and get decision 4's text.
  An older daemon ignores unknown request fields (zod `strip`) and never sends the new outcome.
- Server: Gate A records the branch on the owning lane, finds the seat's own earlier `held` refusal
  for the path, and returns the hand-over once. CLI: the hook adds the two git fields (`git
  rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD`), and fails open to omitting them.
- On this team: lanes start showing branches without anyone typing them, which the board already
  renders. A hand-over refusal is rare: it needs a named-file hold, a refusal, and a hold that ended.
- CooperBench: the second agent in the queue is told at its first post-hold edit that agent1's work is
  on `team/agent1` at a commit, and to merge it first. Whether it does, and whether that wins pairs, is
  the third pilot's question.
- 2026-10-21 (lane 01M5G5G1CP): implemented. The hand-over's state is daemon-local, in ladder v123's
  `gate_hold_refusals` (seat, path, holder lane; the path is never in the audit row) and `lane_heads`
  (the last `git_head` per lane). A hand-over is a `lane.gate` row with `detail.hold = 'handover'`.
  The lane's branch is written through `updateLane`, so it is audited and replicated like any edit.
- 2026-10-21, measured ([finding 017](../research/017-cooperbench-pilot-3.md)): 7 hand-overs in
  CooperBench pilot 3, 1 followed by a merge of the holder's branch before the next edit. The Eval
  rule below (at least half) fails. No pair in that arm was lost to coordination, so the stricter
  ancestry check is not taken up yet; it is re-read if coordination losses return.

## Observability & Evaluation

- **Traces:** `lane.gate` rows with `outcome = 'denied_handover'` (and `hold`, `holder`), by team and
  week; lanes whose `branch` was set by an edit rather than typed.
- **Eval:** for each hand-over, whether the seat's next allowed edit of that file came after its
  branch contained the holder's last-known commit (from the next gate check's `git_head`, checked
  against the holder's), and whether the two lanes' branches later conflicted on the file. The rule
  holds if at least half of hand-overs are followed by the merge. Below that, the hand-over is being
  read and ignored, and the ancestry check rejected above is reconsidered.
- **Experiment:** CooperBench pilot 3, pre-registered: the same two arms and rules as pilot 2, with
  this ADR the one product change, and the patch-base hazard from finding 016 fixed in every arm
  first. Measures: pass count, the per-pair diagnosis, the hand-over follow rate, and cost beside the
  score.
