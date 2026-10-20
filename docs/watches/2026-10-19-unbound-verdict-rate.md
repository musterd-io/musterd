---
question:   After ADR 679, does the rate of verdicts that bind to nothing stay at the baseline the team recorded before the marker existed — and does the marker fire only on the paths it was written for?
claim_ref:  docs/decisions/679-unbound-verdict-is-named.md
falsifier:  "On revisit_by, the `lane.review_unbound` rows written since 2026-10-19 number a rate per day that differs from the baseline by more than an order of magnitude (baseline 3 a day, 139 over the 47 days the audit trail covers), OR a row exists whose `verdict` is `accept` on a lane whose `state` at the row's ts was `awaiting_acceptance` — the marker firing on a verdict that bound."
population: the `lane.review_unbound` audit rows the daemon writes from 2026-10-19, on the revive team, for replies to a `lane_review` ask whose lane had left the acceptance stage.
void_if:
  - the daemon is not rebuilt on a build carrying ADR 679 before 2026-11-18 (no population — the marker never fired)
  - the team records fewer than 20 verdicts on a `lane_review` ask in the window (too little volume to judge a rate)
series:     the `audit` table in `~/.musterd/musterd.db` — `select action, json_extract(detail,'$.state'), json_extract(detail,'$.verdict'), count(*) from audit where action = 'lane.review_unbound' group by 1, 2, 3`
cadence:    read once, at revisit_by
opened:     2026-10-19
opened_by:  dreamy
revisit_by: 2026-11-18
status:     open
---

Opened with ADR 679, whose Decision rests on a frequency claim: a verdict that binds to nothing is
rare enough (139 in the team's recorded history, 3 a day over the 47 days the audit trail covers)
that the daemon may name it without waking anybody. This watch is the measurement of that claim.

A pass means the rate holds — the marker is a report on a rare event, and the decision not to wake
the owner stands. A fail names what changed: a rate an order of magnitude away means the "rare"
premise was wrong and the copy-to-owner lane is overdue; a row on a lane that was still awaiting
acceptance means the marker is firing on a path ADR 679 did not intend, and the gate is too wide.
