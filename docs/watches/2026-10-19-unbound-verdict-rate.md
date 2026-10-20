---
question:   After ADR 680, does the rate of verdicts that bind to nothing stay at the baseline the team recorded before the marker existed — and does the marker fire only on the paths it was written for?
claim_ref:  docs/decisions/680-unbound-verdict-is-named.md
falsifier:  "On revisit_by, the TEAM rate of unbound verdicts since 2026-10-19 differs from the baseline by more than an order of magnitude (baseline 3 a day, 139 over the 47 days the audit trail covers), OR a `lane.review_unbound` row exists whose `verdict` is `accept` on a lane whose `state` at the row's ts was `awaiting_acceptance` — the marker firing on a verdict that bound."
population: the unbound verdicts on the revive team from 2026-10-19 — the accept/decline acts that answer a `lane_review` ask whose lane had left the acceptance stage — and, for the path check, the `lane.review_unbound` rows the daemon writes for them.
void_if:
  - the daemon is not rebuilt on a build carrying ADR 680 before 2026-11-18 (no population — the marker never fired)
  - the team records fewer than 20 verdicts on a `lane_review` ask in the window (too little volume to judge a rate)
series:     the TEAM rate from the messages plus the REPLICATED lane state in `~/.musterd/musterd.db` — the accept/decline acts answering a `lane_review` ask whose lane was not awaiting acceptance (the same derivation as ADR 680's baseline, which is a team count and not a row count). The `lane.review_unbound` ROWS are per-machine — ADR 680's amendment of 2026-10-20 records that `appendAudit` leaves them unstamped, so they exist only on the node that handled the act — so the path check reads them on the node where the acts were sent, and `select action, json_extract(detail,'$.state'), json_extract(detail,'$.verdict'), count(*) from audit where action = 'lane.review_unbound' group by 1, 2, 3` on one machine counts that machine's share only.
cadence:    read once, at revisit_by
opened:     2026-10-19
opened_by:  dreamy
revisit_by: 2026-11-18
status:     open
---

Opened with ADR 680, whose Decision rests on a frequency claim: a verdict that binds to nothing is
rare enough (139 in the team's recorded history, 3 a day over the 47 days the audit trail covers)
that the daemon may name it without waking anybody. This watch is the measurement of that claim.

A pass means the rate holds — the marker is a report on a rare event, and the decision not to wake
the owner stands. A fail names what changed: a rate an order of magnitude away means the "rare"
premise was wrong and the copy-to-owner lane is overdue; a row on a lane that was still awaiting
acceptance means the marker is firing on a path ADR 680 did not intend, and the gate is too wide.

Read the RATE from the team derivation, not from one machine's rows: the rows are per-machine
(ADR 680's amendment of 2026-10-20), so a single database undercounts every act handled
elsewhere. That is also the trap this watch shares with ADR 680 itself — a record on one machine
is a record most of the team cannot see.
