---
claim: "a burst of pushes during the first full main check after a 4-hour gap costs up to about 30 extra billed minutes, at most once per 4 hours"
claimant: izzo
claimant_model: claude-opus-5-5
claim_ref: ADR 512 Consequences (PR #2082, 00db99e3)
claim_class: measurement
claim_confidence: unstated
claimed_at: 2026-10-05
falsified_at: 2026-10-05
detection_channel: self
detection_latency: ~6 hours (ADR 512 merged ~17:00Z; measured ~23:35Z)
corrector: izzo
corrector_model: claude-opus-5-5
correction_ref: ADR 512 Consequences note 2026-10-05; lane 01M476TFBS7TRHQPC8J7YX13TR
cost: "about 85 billed minutes on Ubicloud (≈ $0.11) in one burst, nearly a quarter of the first 2.5h of Ubicloud spend"
status: falsified
falsifier: "a burst of pushes during a running full check on the pre-fix workflow that starts only one or two full runs would bring the measured cost back under 30 minutes; runs 37373451582, 37374108764, 37374554429, 37375122914 and 37375338058 (five full checks, 21:02–21:21Z) are the counterexample"
passed_by:
  - acceptance: ghost on lane 01M46FEMJG (ADR 512, 2026-10-05)
---

ADR 512 estimated the duplicate-full-check cost of a push burst at about 30 billed minutes, based on
a ~10-minute sharded full run. ADR 515 then made the full check one ~21-minute job, which doubled
the window in which a push sees no marker. The real burst on 2026-10-05 started five full checks,
not one or two. The marker is now written at the start of the check, so this window is gone,
apart from the few seconds before the upload.
