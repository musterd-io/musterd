# 631 — user-facing acceptance asks a human only when the change is big or large

- Status: accepted
- Date: 2026-10-16
- Deciders: nick (the ruling), lazara (the record)
- Lane: `01M52YRKRVCYH186G0DY8HMY0D`
- Amends: [ADR 172](172-model-family-posture.md) (any risk tag requires a human), [ADR 188](188-graded-review-ladder.md) §4 (peer then human on any tag). [ADR 530](530-lane-risk-declared-at-open.md) still requires the declaration; it does not decide the gate.

## Context

ADR 172 made any declared `risk` tag a human review. ADR 530 then refused to open a lane whose
scope reaches `packages/web/` or `packages/mobile/` until the author passed a tag or `none`. The
example tag is `user-facing`, and that is the tag seats set. On 2026-10-16, 93 of 97 landed
user-facing lanes carried only that tag. A peer accept on one of them does not close the lane.
It asks nick, and the lane waits until he is live.

The brand-graphics lane `01M4F0S5TE` (PR #2731, ten files) sat twelve hours on that gate, then
closed when nick confirmed a copy change a peer had already checked. He said the category is the
bottleneck: most user-facing work should not need him unless it changes something big or changes
a lot.

## Problem

`user-facing` means "a person can see this." The gate treats it as "nick must approve this."
Those are different claims. A caption, a layout fix, and a tagline refresh all wait on the same
person as a security patch. His attention is the scarce resource ADR 188 already named, and the
tag spends it on the ordinary case.

A size rule alone is the knife [ADR 234](234-tiered-acceptance.md) rejected: the valuable reviews
were small. Nick's ruling is the other way around for this one gate. He would rather a small
visual close on a peer than sit in his queue. The peer review stays. The human stage is what
narrows.

## Decision

1. **`user-facing` alone is a peer review.** A peer accept closes the lane. The tag is still
   declared at open (ADR 530). `--risk none` is still an explicit waiver. `stakes: low` still
   does not exempt a user-facing lane from the peer ask.
2. **A human is required when the change is big.** Big means any risk tag other than
   `user-facing` (`security`, `production`, `destructive`, and the rest), or `stakes: high` on a
   user-facing lane. The author says so. The diff does not.
3. **A human is required when the change is large.** Large means the landed diff has at least
   25 code files plus doc files (`USER_FACING_LARGE_DIFF_FILES`). Tests do not count. Counts
   that were never recorded are not large, so a missing attestation does not invent a queue.
   25 sits above every user-facing landing that had a recorded count on 2026-10-16. The largest
   of those was 12.
4. **The predicate is `humanReviewRequired`.** Every edge that used `risk.length > 0` to mean
   "a human is owed" reads it: the stage-two ask, the retry, the owner's close refusal, the
   submit-time tier, the re-route, and the brief's pending-human line. Storing the tag is
   unchanged. The acceptance-exemption check is unchanged: a risk tag, including `user-facing`,
   still outranks `stakes: low`.

## Consequences

- Ordinary user-facing work closes when a peer accepts it. Nick is asked for another risk tag,
  for a user-facing lane declared `stakes: high`, and for a user-facing landing of 25 or more
  code and doc files.
- A small change that matters, and that nobody marked `high` or gave another tag, closes without
  him. That is the trade he named. The peer is still asked.
- ADR 172 and ADR 188 §4 carry a dated marker. Their Decision text otherwise stands: a tag that
  is not `user-facing` still requires the human, and an agent is still not a substitute for that
  human.
- In-flight lanes pick up the rule when the daemon runs this code. A lane already
  peer-confirmed and waiting on a human under the old rule is not rewritten by this ADR.

## Observability & Evaluation

**Traces.** No new audit action. `lane.review_peer_confirmed` and `lane.review_human_asked` stay
the record of the two stages. A user-facing lane that closes on the peer has a `lane.closed`
row and no `lane.review_human_asked` row. A large or high-stakes user-facing lane still has both.

**Eval.** `humanReviewRequired` is asserted directly: another tag, `stakes: high`, and a diff at
the line each require a human; `user-facing` with a smaller diff does not. The two-stage
integration test submits both shapes: the small one closes on the peer accept, and the one with
25 code-and-doc files escalates.

**Experiment.** n/a — this is a routing rule nick set, not a hypothesis about review quality.
The falsifier is a user-facing lane with no other tag, stakes other than high, and fewer than
25 code and doc files, whose peer accept leaves it waiting on a human.
