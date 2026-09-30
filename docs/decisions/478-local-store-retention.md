# 478 — Local store retention: archive-then-prune audit churn, cap trace content at 7 days, leave sync_log until a joiner can bootstrap

- Status: accepted — 2026-09-29 (nick, in session; deletes data, so a human call)
- Date: 2026-09-29
- Lane: `01M3QQ5BHYK5EC3GAJFR9FRMEE` (goal `cloud`) — the footprint investigation that found this
- Deciders: nick (asked for a laptop that fits), fifty (guardian; owns the daemon's disk)
- Relates to: [ADR 445](445-agent-traces-captured-local-first.md) (the only retention rule the
  store has today — trace content, 30 days, below the corpus watermark; this ADR reuses its shape
  and shortens its window), [ADR 325](325-multi-machine-federation.md) /
  [ADR 331](331-ordering-substrate.md) / [ADR 335](335-sync-wire-format.md) (why `sync_log` cannot
  be pruned yet), [ADR 056](056-research-as-first-class-practice.md) (the research corpus that
  reads `audit`; `scripts/corpus/snapshot.ts` is its capture), [ADR 475](475-cloud-hosted-teams-postgres.md)
  (two backends; this policy is the same SQL on both)

## Context

`docs/perf/local-store-footprint.md` (2026-09-29) measured the dev laptop's daemon: `musterd.db`
is 300 MB and `trace.db` 122 MB, and nothing in `packages/server/src` deletes from `audit` or
`sync_log`. The engine is not the cost — the PGlite spike had already shown SQLite's cache at
~2 MB per connection — the cost is rows that are written forever and read for days.

| store | MB | what it is | oldest row | growth |
| --- | --- | --- | --- | --- |
| `audit` (+ 3 indexes, pk) | ~137 | 333,596 rows since 2026-07-02 | 89 days | ~1.5 MB/day |
| `sync_log` (+ 3 unique indexes) | ~108 | 138,866 hub-staged events since 2026-09-04 | 25 days | ~4 MB/day |
| `messages` | 16 | the acts | | |
| `trace_events` (`trace.db`) | ~110 | 65,439 rows since 2026-09-25; 78 MB is `content` | 5 days | **~20 MB/day** |

`audit` is dominated by lifecycle churn, not decisions: `bootstrap_credential.used` 77,665 ·
`presence.attached`/`.detached` 97,452 · `agent_session_lease.minted`/`.renewed` 50,306 ·
`claim.occupied`/`.superseded`/`.duplicate_workspace` 50,005 · `occupancy.model_attested` 19,320.
The rows the daemon reads back by name (`lane.*`, `ask.*`, `residency.wake_*`, `interrupt.*`,
`policy.change`, `git.pr_merged`, …) are ~25,000 across the same 89 days. Gzipped as JSON lines,
all of `audit` is 14 MB and all of `sync_log` 13 MB.

`sync_log` is the hub's staged canonical order (ADR 335): a peer pulls `hub_seq > cursor`
(`sync/log.ts` `readStaged`), and a **joiner starts at cursor 0** — `laneGenesis` scans the whole
log for the first `lane.opened` so a lane born before replication began does not stop the fold
dead (2026-09-04). The hub keeps `sync_push_cursor` for what it has pushed, but records **no
peer's pull position**; it cannot know which rows every enrolled node has already folded.

`trace.db` already has the shape of a retention rule (ADR 445 increment 3): content older than 30
days is nulled, only below the watermark `corpus:snapshot` stamps, structural columns kept and
`content_pruned_at` set. At today's rate that bound is reached at ~600 MB — five times the whole
coordination database — before the first row qualifies.

## Problem

Decide what the local store keeps, for how long, and what it does with the rest — without
losing the research corpus (ADR 056 reads `audit`, model attestation included), without breaking a
federated peer's fold (ADR 331: absence must stay distinguishable from a gap), and on a laptop
where a `VACUUM` that needs a second copy of the file is itself a hazard.

## Decision

**1. `audit` has two classes, and only churn is pruned.**

- _Decision class_ — kept indefinitely: every action not in the churn list. It is the record
  `lane_*`, acceptance (ADR 202), residency, the wiki one-liners and the research scripts read; it
  is ~7 % of rows.
- _Churn class_ — an explicit allow-list, extended only by editing it: `presence.attached`,
  `presence.detached`, `presence.reattested`, `bootstrap_credential.used`,
  `agent_session_lease.minted`, `agent_session_lease.renewed`, `claim.occupied`,
  `claim.superseded`, `claim.duplicate_workspace`, `claim.reseated`, `occupancy.model_attested`,
  `mcp.surface_rendered`, `continuity.cursor_advanced`, `record.tool_calls`.
- A churn row is pruned when it is **older than 30 days AND below the corpus watermark** _(Amended
  2026-09-29: 5 days, not 30 — [ADR 480](480-audit-churn-five-days.md); see the amendment below)_ — the
  same two-part rule as ADR 445: on a machine `corpus:snapshot` has stamped, nothing the corpus has
  not captured is deleted; a machine that never archived gets the plain 30-day bound. The stamp
  is a second `settings` key beside `content_captured_through`, written by `snapshot.ts` from
  `MAX(ts)` of the captured `audit`.
- Before deletion the batch is **appended to `~/.musterd/archive/audit-YYYY-MM.jsonl.gz`** (one
  row per line, the full row). The archive is the local copy of what the corpus already holds;
  it is not read by the daemon and is not a source of truth (`musterd store archive ls` lists it).
- Rows kept whatever their age, because a daemon read depends on them being there:
  - for each `origin_node`, the row holding `MAX(origin_seq)` — `sync/fold.ts:770` reads it as
    the peer's high-water mark (ADR 331 §Decision 3);
  - for `occupancy.model_attested` and `mcp.surface_rendered`, the **newest row per
    `(team, target)`** — `review.ts:178` (`durableAttestations`) and `toolCalls.ts:208` read
    "latest per seat, unbounded"; a seat idle for a month must not lose its only attestation.
    The prune is `DELETE … WHERE id NOT IN (newest per target)`, and the store test pins it.

**2. `sync_log` is not pruned by this ADR.** The two facts that would make a row safe to delete —
every enrolled, unrevoked peer has folded past it, and a new joiner can start from somewhere other
than `hub_seq` 0 — are both missing. The second is a joiner bootstrap (a state snapshot plus a
cursor), which belongs to ADR 325's federation ladder, not to a retention ADR. Until it lands the
hub carries ~4 MB/day and this ADR records it as the open cost. What _is_ done here: the daemon
logs `sync_log` bytes and row count in `/health` so the number is watched rather than discovered.

**3. `trace.db` content is pruned at 7 days locally, not 30.** Same watermark guard, same
structural-rows-stay rule, same `content_pruned_at` stamp as ADR 445; only the window changes,
and it becomes `trace.content_days` in `config.ts` (default 7; the Cloud tier sets its own). This
partially supersedes the "30 days" figure in ADR 445 §Decision — the mechanism, the watermark and
the structural guarantees stand. At today's rate the local cap is ~140 MB of content instead of
~600 MB.

**4. Space is returned incrementally, not by a blocking `VACUUM`.** The first prune on an
existing database frees ~120 MB of pages that `auto_vacuum = 0` cannot return. `musterd store
prune` runs the policy once (`--dry-run` prints counts and bytes per class and does nothing);
`musterd store compact` is the one-time `VACUUM` that also flips `auto_vacuum = INCREMENTAL`,
refuses to run unless free disk ≥ 1.2 × the file, and is a `service`-class operator action
(guardian seat, announced first — it holds the write lock for the duration). After that, the
daily reaper's `PRAGMA incremental_vacuum` returns freed pages as it goes.

**5. The reaper is the daemon's, daily, and idempotent.** One unref'd timer beside the presence
reaper, first run 10 minutes after boot, batches of 5,000 rows inside a transaction, each run
recording one decision-class `audit` row `store.pruned` `{class, rows, bytes, archive}`. Both
backends run the same SQL (ADR 475).

## Consequences

- One-time, on the dev laptop: `audit` −~290,000 rows / −~120 MB, `trace.db` content −~60 MB once
  rows age past 7 days; `musterd.db` settles near 60–70 MB + `sync_log`, `trace.db` near
  150 MB. `sync_log` keeps growing ~4 MB/day until ADR 325's joiner bootstrap.
- The research corpus loses nothing on an archiving machine (watermark). On a machine that never
  ran `corpus:snapshot`, churn past 30 days is gone from the live db but present in
  `~/.musterd/archive/` — `snapshot.ts` gains `--include-archive` so that machine can still be
  captured whole.
- Daemon readers are unaffected by construction, checked query by query on 2026-09-29: the only
  daemon reads that name a churn action are the two latest-per-seat reads above (kept), `review.ts`
  `selectReviewCounterpart` (which _excludes_ them), and `sync/fold.ts` (which projects incoming
  events, not history). Every other `FROM audit` names a decision-class action. A store test
  enumerates the churn list against the readers' action literals so a new reader of a churn
  action fails the build rather than the seat.
- Wiki one-liners that count churn actions across months
  (`docs/wiki/federation-data-census.md`) report a 30-day window from now on; the page gets an
  invalidate-dated note in the same PR that ships the reaper.
- `SPEC.md` is untouched — retention is a store policy, not protocol.
- Not decided here, on purpose: any prune of `messages` (the acts are the product), of
  decision-class `audit`, or of `sync_log`.

- **2026-09-29, amended by [ADR 480](480-audit-churn-five-days.md):** the first live pass archived
  9,183 rows — 99% of churn was under 30 days old, so the window is 5 days. The rest of this ADR
  stands.

- **Incident, 2026-09-29 18:26–18:50:** the first version of the prunable-set query computed the
  two keep sets as per-row correlated subqueries; on the live 300k-row `audit` a `LIMIT 5000`
  batch did not return in 280 s, and because SQLite work is synchronous the daemon answered
  nothing for ~25 minutes until nick restarted it. Fixed by #1856 (CTE keep sets; the full count
  on the same store takes ~4 s) and pinned by a timing test in `retention.test.ts`. Lesson for
  every store loop: test the query's cost at the live table's size, not only its semantics — the
  first live pass was fast only because the over-30-day set was small.

## Observability & Evaluation

- **Traces:** each reaper run writes one decision-class `audit` row `store.pruned`
  `{class, rows, bytes, archive}` (it is its own trace: the prune shows up in the same table it
  prunes); `/health` gains `db_bytes`, `sync_log_rows`, `sync_log_bytes`, `archive_bytes`;
  `musterd store prune --dry-run` is the operator's readout. No agent-facing path changes, so no
  `traceparent` is added.
- **Eval:** dataset = the dev laptop's `musterd.db` copy of 2026-09-29 (300 MB, 333,596 audit
  rows) and every store test's fixture; baseline = today's numbers in
  `docs/perf/local-store-footprint.md`. Pass: (1) after the first `prune` + `compact`, that copy is
  under 120 MB; (2) the full server suite is green with the reaper on, and a new test enumerates
  the churn allow-list against every reader's action literals; (3) `corpus:snapshot` on the copy
  yields the same `audit` row count with and without `--include-archive`; (4) a two-daemon
  federation test folds after a prune with no `FoldStop` the baseline run did not report.
- **Experiment:** 30 days on the dev laptop after the reaper ships: daily growth of `musterd.db`
  minus `sync_log` under 1 MB/day and `trace.db` under 160 MB, read from `/health`. Above either
  bar the allow-list or the 7-day window is wrong, and this ADR's numbers are amended in
  Consequences. Revisit when ADR 325's joiner bootstrap lands (`sync_log` gets its own ADR) or when
  growth is dominated by a table this ADR does not name.
