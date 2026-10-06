# Up-next relevance

What the record shows about whether `team_next`'s per-member shortlist is picked up more than the oldest-first order it replaced — the baseline behind [ADR 536](../decisions/536-up-next-ranked-per-member.md), the readout that measures it, and the fourteen-day falsifier read.

## What is measured, and what cannot be

ADR 536 ranks `up_next` for the asking seat over the team's pool (a human's handoff pointer › a role the seat holds › a stalled then an in-flight goal › scope near what the seat shipped › the rest), withholds lanes with an unmet dependency, and says how many it hid. Increment 3 makes the ranking falsifiable: every brief read writes a `next.offer` audit row — the five lanes offered with their tier, the five the **pre-ADR-536 rule** would have served from the same board (`baseline`), and the two pool counts. A pickup is the existing `lane.claimed` row with `kind: 'claim'`; a handoff is not a pickup, because the lane was chosen for the seat rather than by it.

`pnpm next:readout [--since YYYY-MM-DD] [--team <slug>] [--json]` reads `~/.musterd/musterd.db` (or `MUSTERD_DB`) read-only, plus the [ADR 478](../decisions/478-audit-churn-retention.md) archive beside it (`next.offer` is churn class and leaves the live store after five days, so a fourteen-day read needs both), and prints three cuts, each with its channel and denominator ([ADR 294](../decisions/294-false-claims-ledger.md) §4), no seat scored. Source and definitions: `scripts/research/next-readout.ts`; the pure halves are tested in `next-readout.test.ts`.

1. **Hit rate.** Claims whose lane was in the window offered to that seat in the hour before, over claims that had any offer in that hour — by rank, and the same claims scored against the baseline window.
2. **Tier yield.** Of the ranked hits, which tier placed the lane. This is the number that decides whether a `lane_open` nudge for a missing `role` is worth adding (spec §2): three of 74 open lanes carried a role the day this shipped.
3. **Window honesty.** Share of brief reads whose claimable pool was deeper than the window of five — how often the "N of M claimable" line is doing work.

**What the record cannot give (2026-10-06; falsify: a `next.pickup` row, or an offer id on `lane.claimed`).** A claim does not name the brief read that prompted it, so the join is by actor and time — the seat's newest offer inside the hour. A seat that reads the brief, works on something else, and claims an offered lane 61 minutes later scores as a miss for both orders; so does a pickup prompted outside the record (a chat instruction). Both bias the comparison toward neither side. <!-- claim: other -->

## The baseline (2026-10-06, `~/.musterd/musterd.db`; falsify: re-run `pnpm next:readout` on the same DB and get different counts) <!-- claim: other -->

Read the evening increment 3 landed, before any `next.offer` row existed: every count is zero and the verdict is `INSUFFICIENT`. The pre-change behaviour is recorded in ADR 536's Context instead — on the 74 open lanes of that morning, the oldest-first window served the same five launch dogfood lanes to every seat and hid 69, 44 of them with an unmet dependency.

## The fourteen-day read (due 2026-10-20)

ADR 536's Experiment: fourteen days after increment 1 landed on revive (#2160, 2026-10-06), run `pnpm next:readout --since 2026-10-06`. The script prints the verdict line itself:

- **Falsifier met** — with five or more claims that had an offer, the ranked hit rate is at or below the baseline's. Then decision 3 (the tiers) is reverted and decisions 2 and 4 (the exclusion, the counts) are kept; they are honesty, not relevance. The reading goes into ADR 536's Consequences as a dated note.
- **Not met** — the ranked order is picked up more than the order it replaced; it stays, and the tier yield says which signals earned it.
- **Insufficient** — fewer than five claims had an offer in the hour before; keep collecting, and say so.
