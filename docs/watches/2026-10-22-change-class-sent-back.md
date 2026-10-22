---
question: Does change_class predict a sent-back, once both nodes store the same actor_model on the submit?
claim_ref: docs/decisions/612-change-class-labelled-at-submit.md
falsifier: "A class with at least 30 submits in the population is sent back materially less often than the blended rate of that same population. Below 30 the class is not rated. A model string is a count inside a rated class, and a count under 30 is not a rate. This watch does not name a best model."
population: lane.ready_for_review rows whose id carries the same non-null actor_model on mac.lan and on macbook-air-2.lan, and whose detail carries change_class. The population starts at the first such agreeing id after this watch opens. Rows folded before the push copied the stamp stay out. A null on one node and a model on the other is a disagreement, not a member of the population.
void_if:
  - no lane.ready_for_review id after this watch opens has the same non-null actor_model on both nodes. The push fix never reached a joiner, and there is nothing to read
  - fewer than 30 rows in the population carry a change_class. A class rate over a smaller set is the blended rate wearing a label
  - the class list or its order in packages/protocol/src/changeClass.ts changes inside the window
  - a return of a lane stops being recorded as lane.review_sent_back
series: one read at revisit, of audit on both daemons, joined on audit id for lane.ready_for_review, lane.review_sent_back, and lane.closed. No sweep.
cadence: read once, at revisit_by
opened: 2026-10-22
opened_by: TJ
revisit_by: 2026-11-15
status: open
---

ADR 612 already asked whether the kind of landed diff predicts acceptance, and it set the bar at 30
submits in a class before a class may route differently. This watch is that read, with one addition
the stamp makes possible: the attested model on the submit, as a count beside the class.

The addition is a count because the seat still chooses the model and the task. A rate by model inside
a class would answer a question this window was not assigned. The cookoff (ADR 122) is where a model
is the thing that varies.

`change_class` stays the type. Nothing else is labelled for this read.

The origin node already stamped `actor_model`. The push omitted it, so the other node stored null
and the two copies of one id disagreed. The push now copies the stamp. Decision 4 of ADR 416 leaves
the earlier rows null. They are not repaired into this population.
