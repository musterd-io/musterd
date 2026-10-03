# 500 — A seed-thread entry waits for nothing: held, then projected when its seed arrives

- Status: accepted
- Date: 2026-10-02
- Relates to: ADR 371 §3 (the record kind; `record.seed_thread` and the `seed_unborn` stop), ADR 399
  (the seed kind — captures cross as `seed.captured`), ADR 381 (the genesis watermark — the same
  wedge, for lanes), ADR 365 (block-don't-skip)
- Decided by: nick, 2026-10-02 ("i give you permission to go ahead"), recorded by stanley
- Lane: `01M3ZYPEFDSQEJ9F797EDHF1XV`, found by the second-laptop run (`01M3YZ0AY0`)

## Context

ADR 371 §3 made a thread entry for a seed the daemon does not hold a **stop**, `seed_unborn`,
retried every tick: the seed was "at most one relay poll away". ADR 399 found that premise false for
a joiner without the relay's token and made captures cross as their own kind — but kept the stop
"exactly as written", reasoning that its window now closes by fold. It also recorded the hub's 53
seeds as historical (41 `repo`, 12 `slack`) and found no live wedge.

Both ADRs assumed every seed has a birth in the log. The 53 historical seeds do not: they were
captured before ADR 399 began stamping `seed.captured`, and nothing stamps them now.

Measured 2026-10-02 on nick's second MacBook Air, enrolled fresh at the laptop hub (node
`01M3ZEHWQD9PXPKEYMHGKK2YTM`):

- dolly's 2026-09-30 triage wrote **64** `record.seed_thread` entries (a brief and a conclusion
  each) on **31** historical `repo` seeds, at hub_seq **147,019–147,207**.
- The joiner's fresh drain folded 60 pages in 18 s and stopped at 147,019, permanently. The page
  holding that entry was re-pulled every minute after; the cursor never moved.
- The hub's log holds one `seed.captured` for the 32 relay ids those entries name (ADR 399's own
  live falsifier). No relay poll can supply the rest — `repo` seeds are not on the relay at all, and
  a joiner holds no relay token by ADR 390/344's rule.

Every joiner that folds that range meets it. delta (the Fly joiner) was folding near the head on
2026-09-30, so it almost certainly stopped there too. The seats on Air 2 could not move until it
cleared.

## Problem

ADR 381 solved the same wedge for lanes: tell a transition whose birth **will never arrive** from
one whose birth is merely **not here yet**, and advance only the first. That discriminator does not
carry over. Lane ids are ULIDs, so "older than the log's first birth" is a comparison. A seed is
named by `relay_id` (`repo:docs/decisions/027-…#…`), which says nothing about when the seed was
captured, and the entry carries no capture time.

## Decision

**A thread entry is an append, so it does not have to wait: the fold holds it, and the seed's
birth projects it.**

1. **No stop.** A `record.seed_thread` whose seed this daemon holds no row for still resolves its
   writer (an unknown name is git lag, `unresolved_seat`, unchanged). Its audit row then lands with
   its stamp, exactly as a projected one does, and the batch goes on. No `seed_thread_entries` row
   is written — there is no seed to hang it on. The `seed_unborn` stop shape is removed.

2. **The birth projects what was held.** Every local birth of a seed — a folded `seed.captured`, a
   relay ingest, a repo capture — then projects the held entries for that `relay_id` from `audit`
   (`projectHeldThreads`, keyed on `audit.target`, which the stamp already sets to the relay id).
   `INSERT OR IGNORE` on the entry's own id makes it a no-op for everything already projected.

3. **Held stays findable.** `foldBatch` reports the entries it held, and the pull logs one
   `sync_fold_seed_thread_held` line per page that held any (count, the first relay id and hub_seq).
   A seed that never arrives is visible there and in `audit`; it no longer stops anything.

**Why this is not ADR 381's rejected "skip every unborn lane".** That rejection rests on order: a
lane transition is a state change, and applying a later one without the earlier ones yields the
wrong row, so a birth that is merely late has to block. An entry is an independent append, keyed by
its own id, with its own `created_at`; the table it lands in has no state for order to corrupt.
Projected late, it is the same row it would have been on time — so the block buys nothing, and for
a seed with no birth it costs the whole fold. A genuine hole is still findable (decision 3); it just
no longer takes every later event down with it.

### Rejected

- **Stamp the historical seeds on the hub.** A backfill appends `seed.captured` at the log's end,
  after the entries it would have to precede: a fresh joiner still stops at 147,019 and never reads
  the stamps. It is worth doing for its own sake — a joiner would then hold those seeds — and with
  decision 2 it heals what decision 1 held. It is a follow-up, not the fix.
- **A seed watermark, ADR 381's way.** There is no order on `relay_id` to put one on. Shipping the
  set of born relay ids per page is a protocol change to carry what decision 2 reads locally.
- **Fetch the missing seed from the hub on demand.** A new endpoint and a network call inside the
  fold's transaction, for rows the fold can hold without either.
- **Copy the rows into the joiner's database by hand.** It clears one machine once, by hand, and
  the next machine to enrol meets the same entry.

## Consequences

- A joiner drains past seed-thread entries for seeds it does not hold. Air 2 and delta clear on
  their next tick once they run a build with this.
- Those 31 historical seeds, and their 64 entries' projections, stay off every joiner until a hub
  backfill stamps the seeds; the entries are in the joiner's `audit` meanwhile. The hub's seeds are
  unchanged.
- `seed_unborn` leaves `FoldStop`; `FoldResult` gains `held_seed_threads`. Server-internal — no
  protocol schema change, no migration.
- Each local seed birth runs one indexed `audit` read (`idx_audit_team_action_ts`, about 65 rows on
  this team today). On a hub it projects nothing, because every entry is already projected.
- `record.seed_thread` is not churn (`store/retention.ts`), so a held entry is not pruned before
  its seed can arrive.

## Observability & Evaluation

**Traces.** No new span. `sync_fold_seed_thread_held` replaces `sync_fold_seed_unborn`, as a warn
rather than a stop. Falsify on two live daemons: a joiner stopped on `sync_fold_seed_unborn` at
hub_seq 147,019, upgraded to this build, advances its `sync_pull_cursor` past 147,207 on its next
tick and logs `sync_fold_seed_thread_held` for those relay ids.

**Eval.** The claim is "a joiner drains past entries for seeds it does not hold, and gets them
whole once it does". Baseline 2026-10-02, before this: Air 2's cursor at 147,018 across repeated
ticks, 12,180 hub events behind. After: the cursor reaches the head on the next tick. The control is
the on-time entry in `sync/seed.test.ts` — an entry whose seed is already here still projects at once
and is not reported held — so a build that held everything would fail it.

**Experiment.** None — no flag. A single-machine team never folds, and a joiner whose every seed has
a birth before its entries never takes the branch.

## Falsifiers

1. `sync/record.test.ts`: two entries for a seed the daemon does not hold fold in one batch with no
   stop, the cursor past both, both audit rows present and no thread row; the seed's later relay
   ingest projects both, once. Fails without decision 1 — the first entry stops the batch.
2. `sync/seed.test.ts`: an entry folded before its seed's `seed.captured`, in the same batch, is
   held and then projected by the capture. Fails without decision 2 — the seed lands with an empty
   thread.
