---
question:   Is the rise in ADR 250's headline read transient? Asks-to-founder per merged PR ran 0.06–0.11 in 2026-W34–W38, then 0.21 (W39) and 0.15 (W40 to date). Over the next four ISO weeks, does it fall back to that band, and what do the capability-miss and repeat-wake reads report beside it?
claim_ref:  docs/decisions/250-loops-one-week-in-judgment-throughput.md
falsifier:  "At revisit_by, `pnpm adr250:asks-per-pr` shows at least three of 2026-W41, W42, W43 and W44 at 0.11 asks/PR or lower. That means the W39–W40 rise was transient. Two or more of those weeks above 0.11 means the rise holds. The ADR predicted the opposite direction, so a holding rise is the finding, and it goes to ADR 250 Consequences as a dated note. Capability-miss has no pass bar here: backlog item 3 has not landed, so ADR 250's rule that any nonzero week is a routing bug is not armed yet. Record the inert share and the repeat clusters only. Repeat wakes has no pass bar either: backlog item 1 (per-edge firing memory) has not landed. Record the repeat share of DEFERRED and FAILED outcomes separately, because ADR 250 §2 never sums the two halves."
population: every directed `ask` to a human member in the daemon's `messages` table, and every `git.pr_merged` audit row, in ISO weeks 2026-W41 to W44. For capability-miss, the lane-scoped landings in the same weeks. For repeat wakes, the deferred and failed wake outcomes in the same weeks. Rows from before 2026-10-05 are baseline only.
void_if:
  - "a week in W41–W44 has fewer than 20 merged PRs. A ratio over so few PRs measures volume, not asks. Report that week, but leave it out of the falsifier count."
  - the definition of asks or merged PRs changes in `scripts/research/adr-250-asks-per-pr.ts` inside the window. The verdict must not move under the measurement.
  - ADR 250 backlog item 2 (the merge loop) or item 4 (acceptance absorption) lands inside the window. Then the question changes to "did it fall after the landing", and that needs a new watch.
series:     "`pnpm adr250:asks-per-pr`, `pnpm adr250:capability-miss` and `pnpm adr250:repeat-wakes`, all read-only over `~/.musterd/musterd.db`. There is no sampler. The ledger is the series, and the per-ISO-week table is the read."
cadence:    "weekly, Monday. The reader is dolly. Each read posts one `status_update` to @team with the three lines, naming this watch. The verdict is due at revisit_by."
opened:     2026-09-29
opened_by:  dolly
revisit_by: 2026-11-02
status:     open
---

Opened to close the second half of lane 01M1MMMDCRYFA0G9RVZQ7H7WX9. PR #1286 built the two missing
instruments (finding 010). This watch gives them a reader and a cadence. The lane named that gap:
"building it is the easy half." This uses ADR 297's watch primitive and adds no new scheduler.
`watch:check` fails the build if this watch is still open after `revisit_by`, so nobody can drop
the read quietly.

**Readings at open (2026-09-29, all-time).** `adr250:asks-per-pr`: 103 asks to humans against 945
merged PRs, which is 0.11 asks/PR. All 103 went to nick. `adr250:capability-miss`: 802 landings,
46 inert (6%), 5 repeated (member, lane, edge) triples. The two 13× gptbot `dispatch_continuation`
clusters from finding 010 are still the two largest. `adr250:repeat-wakes`: 930 deferred outcomes,
81% of them repeats, and 152 failed outcomes, 48% of them repeats. The deferred half includes two
142× clusters from 2026-09-29 alone: izzo and ryder, `dispatch_continuation`,
`attended-session-open`.

_Added 2026-09-29 (dolly), after acceptance:_ repeat wakes joined the weekly read. Finding 009 read
it once. Before this, ADR 250's note claimed all three reads had a cadence, but the watch covered
two. Wanderer carried that as a caveat on the acceptance.
