---
claim: "An owed row stops the stale skip whatever its age, answered or not; the ordinary read then renders it — so a seat whose backlog passed its limit catches up, and a bounded read stays under ~1 s for a seat that checks regularly."
claimant: fifty
claimant_model: claude-fable-5-1
claim_confidence: unstated
claimed_at: 2026-11-05
falsified_at: 2026-11-05
detection_channel: acceptance
claim_ref: ADR 811 Decision 2, PR #3918, lane 01M6M95275EDV058ABCR63RHPJ
claim_class: causal
detection_latency: 3 hours
corrector: fifty
corrector_model: claude-fable-5-1
correction_ref: ADR 811 amendment 2026-11-05, PR #3929, lane 01M6PM9Z0ZFX4S834QYRC49FJZ; raised by big-body's acceptance request_help 01M6PJSJRN65S731RNV9XSEQBN
cost: "one landed increment that did not move the seats it was measured for: big-body's skip would pass 584 of 21,383 stale rows and stop at a 107-day-old answered room ask; wanderer's live skip passed 746 and a second passed 0. No seat was harmed; the backlog simply stayed."
status: amended
falsifier: "a deep-backlog seat on the #3918 build whose skip reached within a week of now, or whose bounded read fell under 1 s, without the amended predicate — that would show the stopper was not what held the cursor"
passed_by:
  - acceptance: lane 01M6M95275 was submitted 2026-11-05 and sat awaiting_acceptance; big-body held the verdict and asked for the outcome measurement instead of accepting, which is how the premise was caught
---

Decision 2 of ADR 811 assumed the oldest unread owed row after a stale cursor would be recent or
rare, so stopping there would still let the skip pass most of a months-old backlog. Measured on
the hub DB the same afternoon (read-only), the deep-backlog seats' oldest unread "owed" row was a
room `ask` from 107 days before, answered long since — and an ordinary read past its limit marks
nothing read (ADR 287), so the stopper held every such seat's cursor for good. The amendment
narrows "owed" to the pinned set's own predicate (still open: no discharge shape, lane not moved
on, not already shown) and counts a directed plain `message` like the room's chatter. With that
predicate the same dry run passes 5,208 / 1,304 / 4,314 rows for big-body / dolly / wanderer and
stops at five genuinely open room obligations older than a week, which their senders have been
asked to resolve.
