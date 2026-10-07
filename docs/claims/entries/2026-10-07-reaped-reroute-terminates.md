---
claim: "the reaped-acceptance re-route terminates by construction, not by a counter — once re-routed, the lane's open ask belongs to a live seat, so the next tick no longer names it; a lane comes back only if its new reviewer also vanishes"
claimant: ryder
claimant_model: claude-opus-5
claim_ref: ADR 414 Decision, "It terminates by construction, not by a counter" (PR #1546, f3b38268; lane 01M2RQ8W0RR838P2KW3SP6SYGV)
claim_class: absence
claim_confidence: unstated
claimed_at: 2026-09-17
falsified_at: 2026-10-07
detection_channel: peer
detection_latency: ~20 days (first suspend-coincident re-route 2026-09-24; found from the audit log 2026-10-07)
corrector: stanley
corrector_model: claude-opus-5-5
correction_ref: lane 01M4BJX7JJE396AP3G8QSN10PF (opened by miley from the audit log); ADR 414 Consequences note 2026-10-07
cost: "39 re-routes across 3 lanes since 2026-09-24, 37 of them on lane 01M49JNJG3 overnight 2026-10-06/07; each superseded the ask a seat held, so miley's accept 01M4BJTK8N bound to nothing and the lane waited for a human to close it"
status: falsified
falsifier: "a host suspend with an acceptance held by a seat that reconnects within the presence timeout: zero lane.review_rerouted rows would show termination; one per sleep is the counterexample"
passed_by:
  - acceptance: miley (lane 01M2RQ8W0RR838P2KW3SP6SYGV closed counterpart_confirm, 2026-09-17)
---

ADR 414 argued that the reaper's re-route can't loop. Once it moves an ask, the ask belongs to a
seat the picker saw as live, so the next tick leaves it alone. That reasoning assumes "live" is read
over a window in which the daemon was listening. It wasn't. The sweep ran on the first tick after
every host suspend. At that point the holder's presence row was stale by the clock alone, and
whichever seat's heartbeat landed first looked live, so it got the ask. The next sleep moved it
again.

Every one of lane 01M49JNJG3's 37 re-routes on 2026-10-06/07 fell within 5 s of a
`residency.host_suspended` row. `reapStale` already had the guard for exactly this case (lane
01M1HNY302): it judges no silence until it has listened for a full presence timeout. The
acceptance sweep, which runs earlier in the same tick, didn't. Lane 01M4BJX7JJ gives it the same
window.
