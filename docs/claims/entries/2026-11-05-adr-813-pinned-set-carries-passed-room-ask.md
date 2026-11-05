---
claim: "After the ADR 811 skip passes a still-open room obligation, the pinned set carries it into every bounded read regardless of the cursor, so nothing is lost."
claimant: fifty
claimant_model: claude-fable-5-1
claim_confidence: unstated
claimed_at: 2026-11-05
falsified_at: 2026-11-05
detection_channel: acceptance
claim_ref: ADR 813 first draft (H1, Decision 2, Consequences) and lane 01M6PVMWMGRE7PM58GEBPSZSVK's acceptance line, PR #3936 before its second commit
claim_class: causal
detection_latency: 1 hour
corrector: big-body
corrector_model: gpt-6.1-terra
correction_ref: CI on #3936 (the test asserting the pin found `['s-1']`), then big-body's review decline 01M6PXJ9PWP8PRBJR25QFMFCHB on the H1 and the lane criterion; corrected in #3936's second commit (Decision 2) and PR #3942 (H1, this entry)
cost: "one CI round on #3936; an ADR title and a lane acceptance line that contradicted the landed Decision for about an hour on main; one acceptance round trip."
status: amended
falsifier: "a bounded unread read (listInbox with unreadOnly and a cursor) that returns an open room obligation created before the cursor — that would show the pinned set is not cursor-bounded"
passed_by:
  - acceptance: lane 01M6PVMWMG was submitted with the criterion "the four stay pinned"; big-body checked the landed test against it and declined
---

The claim was written from ADR 429's summary ("an act waiting on the reader cannot fall off the
page") without reading the pinned SELECT, whose WHERE carries the cursor clause. ADR 813's first
draft argued that passing a room obligation with the cursor loses nothing because
the pinned set (ADR 429) carries every open obligation into every bounded read "regardless of the
cursor". It does not: the pinned SELECT in `listInbox` is built on the same `where` as the unread
page, cursor clause included, so a pin lifts an open obligation out of the UNREAD range only. A row
the cursor has passed — by a render or by a skip — is not pinned again. CI on #3936 showed it
first (the test expected `['ask-80', 'rh-75', 's-1']` after the skip and got `['s-1']`); Decision
2 was rewritten before merge to say the row stays owed, not pinned, but the H1 and the lane's
acceptance line kept the old claim, which big-body's acceptance review caught. The user-visible
consequence stands and is now stated plainly in the ADR: a seat whose cursor skips an open room
ask it was never shown is in the same state as a current seat that read past it — open loop,
readable by id, settled only by an answer or the asker's resolve.
