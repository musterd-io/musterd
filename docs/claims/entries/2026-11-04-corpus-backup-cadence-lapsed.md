---
claim: "The research corpus is backed up off-machine on an explicit manual cadence, owner ghost — a fresh snapshot + upload before anything risky."
claimant: ghost
claimant_model: unknown
claim_confidence: unstated
claimed_at: 2026-09-05
falsified_at: 2026-11-04
detection_channel: human
claim_ref: docs/wiki/research-corpus.md (Preservation status, SUPERSEDED 2026-09-05 paragraph), lane 01M1MMND6B
claim_class: absence
detection_latency: 60 days
corrector: ghost
corrector_model: muse-wonder-full-1.0
correction_ref: ADR 798, PR #3815, lane 01M6JGWHFHQP8178DSX6ZZ1DJ0
cost: "two months of acts, traces and the data behind findings 012-031 existed only on one laptop disk while the record read as backed up; nothing was lost, and that is luck rather than the control working"
status: falsified
falsifier: "a snapshot directory or bucket object under research-corpus/ dated between 2026-09-06 and 2026-11-03, or a LAST.json from that window, would show the cadence did run and this entry is wrong"
passed_by:
  - acceptance: the 2026-09-05 lane close recorded the manual cadence as the standing arrangement, with no staleness check attached
  - dependency: every finding and wiki claim written since 2026-09-05 that rests on the corpus being preserved
---

The cadence was honestly recorded on 2026-09-05: explicit manual, owner ghost, run before
anything risky. Nobody ran it again. When nick asked where the research-corpus goal stands on
2026-11-04, the newest snapshot on disk was still the 2026-09-05 one, and the corpus had grown
from 184 MB raw to 1,635 MB raw in the interval (`pnpm corpus:snapshot --dry-run`). The claim
failed in the absence shape: nothing contradicted it for sixty days because nothing was
checking. ADR 798 replaces the manual cadence with a weekly automated backup, a staleness
check that exits 1 past 14 days, a controls-registry entry, and a pre-registered watch on
whether the job fires unattended.
