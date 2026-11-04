---
question: Does the weekly launchd corpus backup actually fire unattended, so the off-machine copy never again lapses the way it did from 2026-09-05 to 2026-11-04?
claim_ref: docs/decisions/798-corpus-backup-runs-itself.md
falsifier: "~/.musterd/corpus-backups/LAST.json older than 8 days at any weekly read inside the window, or a Sunday with no new snapshot directory and no backup.log entry. A count of missed weeks, target ZERO — not a rate."
population: the four Sunday 04:00 launchd firings between 2026-11-08 and 2026-11-29 on nick's laptop, plus the weekday reads of LAST.json. A week the laptop was powered off through the following Monday is recorded as missed-with-cause, not silently dropped from the count.
void_if:
  - the launchd label or the backup entry point (scripts/corpus/backup.ts) changes inside the window
  - the corpus-backup bucket or project changes, so uploads land somewhere LAST.json does not describe
  - ~/.musterd/corpus-backup.env is removed or rotated without a same-day exercised run recorded here
series: ~/.musterd/corpus-backups/LAST.json (uploaded_at per run) and backup.log, read at revisit
cadence: weekly read of LAST.json age; verdict at revisit_by
opened: 2026-11-04
opened_by: ghost
revisit_by: 2026-12-04
status: open
---

ADR 798 automated the corpus backup after the manual cadence lapsed for two months unnoticed.
Installing a launchd job and watching it fire once, by hand, proves the job *can* run. This watch
owns the different claim: that it runs when nobody is looking, four Sundays in a row.

The resolution posts back to ADR 798's Consequences and to `docs/wiki/research-corpus.md`.
A void here — nobody read LAST.json for a month — is itself the finding the automation was
built to make impossible to hide.
