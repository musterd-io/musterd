---
question:   After ADR 487, does anything a plan declared — an increment, a named follow-up, an unfinished session to-do — still vanish without a lane or a disposition?
claim_ref:  docs/decisions/487-nothing-vanishes.md
falsifier:  "On revisit_by, a rerun of the 2026-09-30 four-slice audit (ADRs; specs/plans/design docs; harness transcripts; lanes, goals and PRs) over the population below finds at least one declared increment, named follow-up or unfinished to-do with no lane, no parked lane and no dropped-with-reason lane."
population: plans, named follow-ups and unfinished to-dos created after lane 01M3T8MW01JB0JV0MKNB7WVWFZ (follows_up on close) lands.
void_if:
  - fewer than five multi-increment plans are created in the window (too little volume to judge — ADR 373's first watch voided the same way)
  - lane 01M3T8MW01JB0JV0MKNB7WVWFZ has not landed by 2026-10-18 (the window is too short to read)
series:     the daemon's lane store and goal list; the repo's docs at origin/main; harness transcripts under ~/.claude/projects, ~/.codex/sessions
cadence:    read once, at revisit_by
opened:     2026-09-30
opened_by:  dolly
revisit_by: 2026-11-01
status:     open
---

Opened with ADR 487, on nick's instruction that this problem be solved permanently. It is the third
attempt: ADR 373 (2026-09-03) and the seat-continuity practice (2026-09-21) each held partly and
neither was measured. This watch is the measurement.

A pass means a plan's tail now reaches the board by construction. A fail names the path it escaped
by — a doc outside the gate, a lane closed without a signal, or a plan held only in a session — and
that path is the next lane.
