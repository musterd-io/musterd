# MCP fast path: what each cut bought, measured against one baseline

Lane `01M562HNQF47JM32EAVVHZMTAA` (goal `live-loads-fast`). The speed changes under TJ's
`mcp-fast-path` goal were each measured alone, on different machines and loads. This page puts the
cold-start ones on one machine, in one run, interleaved, so they can be read against each other.

## Cold start, by change (2026-10-17; falsify: re-run the command below on a machine with a 1-minute load under 8 and put the A→E wall-time drop outside 35–55% with `/health` instant, or outside 60–80% with `/health` delayed 300 ms)

Time from the adapter's process start to its `tools/list` reply (31 tools every run), median of
25 launches per ref, the refs launched round-robin and the order reversed each round. Apple M3,
8 CPU, 8 GiB, node v22.23.3, darwin/arm64, 1-minute load 4 on 8 CPUs. An earlier run of the first
five refs the same day, at load about 10, gave the same ordering (A→E −34% instant, −61% delayed),
with wider ranges.

| Ref | What it is | wall, `/health` instant | CPU, instant | wall, `/health` +300 ms | CPU, +300 ms | `tools/list` bytes |
| --- | --- | --- | --- | --- | --- | --- |
| A `3da54a0c` | before the bundle (parent of #2435) | 343.4 ms (261–433) | 443.7 ms | 532.8 ms (499–801) | 309.8 ms | 19,664 |
| B `1471ab70` | #2435 bundle the harnesses launch (ADR 574) | 249.9 ms (167–348) | 262.0 ms | 477.6 ms (442–681) | 190.9 ms | 19,664 |
| C `1cbd1e65` | #2458 compile cache (ADR 577) | 211.1 ms (151–264) | 233.3 ms | 458.0 ms (432–550) | 168.3 ms | 19,664 |
| D `faa60d3a` | #2474 serve initialize without waiting on `bind()` | 204.6 ms (151–255) | 218.0 ms | 135.8 ms (116–243) | 158.6 ms | 19,664 |
| F `b8fcb7f3` | parent of #2476 | 192.4 ms (145–333) | 208.3 ms | 140.9 ms (116–289) | 153.6 ms | 19,664 |
| G `064f0ef2` | #2476 hot tools load without a schema search | 195.2 ms (143–321) | 208.1 ms | 145.9 ms (117–220) | 166.5 ms | 19,816 |
| H `5b0d2261` | #2517 short inbox reply by default | 194.3 ms (135–296) | 209.6 ms | 141.7 ms (116–354) | 164.8 ms | 19,811 |
| E `5895c173` | `main` on 2026-10-17 | 191.9 ms (160–297) | 217.9 ms | 151.2 ms (127–401) | 165.0 ms | 20,955 |

Step by step (wall / CPU, change in the median):

| Change | instant `/health` | `/health` +300 ms |
| --- | --- | --- |
| A → B, the bundle | −27.2% / −41.0% | −10.4% / −38.4% |
| B → C, the compile cache | −15.5% / −11.0% | −4.1% / −11.8% |
| C → D, initialize without `bind()` | −3.1% / −6.6% | **−70.3%** / −5.8% |
| D → F, other changes between | −6.0% / −4.4% | +3.8% / −3.2% |
| F → G, #2476 hot tools | +1.5% / −0.1% | +3.5% / +8.4% |
| G → H, #2517 | −0.5% / +0.7% | −2.9% / −1.0% |
| H → E, everything since | −1.2% / +4.0% | +6.7% / +0.1% |
| **A → E, the whole set** | **−44.1% / −50.9%** | **−71.6% / −46.7%** |

What the table says:

- **The bundle (#2435) is most of the CPU win**, about 41% of the process's own work.
- **#2474 is a wall-time win only when the daemon is slow to answer `/health`.** With an instant
  stub it is −3.1% and inside the noise; with a 300 ms `/health` it removes the wait (−70%). A fast
  local daemon hides it, which is why the CI check (instant stub, CPU time) cannot see it.
- **The compile cache (#2458)** is −15.5% wall and −11% CPU with an instant `/health`.
- **#2476 and #2517 cost no startup time that this run can see** (F→G, G→H are inside the ranges).
  #2476 adds 152 bytes to `tools/list` (19,664 → 19,816), the figure its PR gave. `tools/list` is
  20,955 bytes on `main` today, 1,139 more than at #2517, from descriptions added since.
- **D → E on the slow-`/health` side reads up** (+11.3% wall from D to E, 135.8 → 151.2 ms; CPU
  +4%). The ranges overlap (116–243 against 127–401, with one 401 ms launch in E) and the instant
  side reads down (−6.2%), so this is not shown to be a regression. The earlier busy-machine
  run's +6.7% on the instant side did not reproduce.
- **First launch** (the harness's first, with a cold compile cache), instant `/health`: A 407.5 ms
  → E 306.9 ms wall.

Reproduce: `node scripts/mcp/ladder.mjs "$PWD" 25 A=1471ab70^ B=1471ab70 C=1cbd1e65 D=faa60d3a
F=064f0ef2^ G=064f0ef2 H=5b0d2261 E=origin/main`. It builds each ref in a scratch worktree (`pnpm
install --frozen-lockfile --filter @musterd/mcp...` then build), stands a stub in for the daemon's
`/health`, and sets no `NODE_COMPILE_CACHE` so the adapter's own cache is part of what is
measured. The medians, minima and maxima are in the tables above.

## Live launches (the report's `tool_calls.startup`, last 7 days, ADR 584)

Real launches by the harnesses, not the bench. Time to the `tools/list` reply:

| Surface | launches | p50 | p90 |
| --- | --- | --- | --- |
| claude-code | 141 | 269 ms | 1245 ms |
| grok | 30 | 290 ms | 759 ms |
| opencode | 17 | 244 ms | 380 ms |
| codex | 9 | 486 ms | 1172 ms |
| muse | 4 | 225 ms | 853 ms |
| cursor | 2 | 432 ms | 5323 ms |

The live p50s sit near the ladder's E row; the p90s are 2.4–4.6× the p50 on the three busiest surfaces.
There is no live data from before 2026-10-13 (ADR 584), so this is a current reading, not a
before/after.

## Wake-lease poll (#2511), reproduced on a copy of this machine's database

Every wake-lease poll runs the open-directed ledger. #2511 found its "answered by anyone" clause
mis-planned on the hub: `messages` had planner statistics from 17,207 rows, v93 added
`idx_messages_thread_act_ts` without an `ANALYZE`, and the index with no statistics row won the plan.
The fix re-analyzes any table whose statistics miss an index, at daemon start.

The hub's database is not on this machine, and this machine's has no planner statistics at all (so it
never had the problem: its own poll is p50 357–360 ms, p90 436–453 ms over 14,201 polls on 10-16
and 10-17). So `scripts/perf/wake-lease-stale-stats.mjs` copies this machine's database, loads the
hub's `sqlite_stat1` rows for `messages` (the same ones `db.test.ts` loads), and times
`openDirectedLedger` against that, in fresh processes, 7 round-robin runs, on `main` `5895c173`:

| Condition | ledger root query, median (min–max) | Rows | One-off cost |
| --- | --- | --- | --- |
| Before: statistics left stale (the daemon's start before #2511) | 501.2 ms (484–642) | 167 | – |
| After: `analyzeTablesMissingIndexStats` run (its start now) | 29.2 ms (29–32) | 167 | `ANALYZE messages`, 32.4 ms |

That is −94%, with the same rows back. The hub's own figures were 3.2 s → 0.026 s for the query and
2.3–3.1 s → 0.12–0.34 s for a whole poll; this copy has 167 open acts and about 2,100 accept/decline
rows against the hub's 468 and 1,685, on a faster machine, so the absolute times differ and the
direction and cause agree. The harness times the query, not the HTTP poll. One build serves both
conditions because #2511 changed nothing but that start-up step, and a pre-#2511 build refuses this
database (schema 106 against its 94). `sqlite3` on the same copy agrees: 0.42–0.6 s with the stale
rows, 0.6–4 ms after `ANALYZE messages`.

## `team_inbox_check` reply size (#2517)

`scripts/perf/inbox-reply-bytes.mjs` builds the parent of #2517 and the merge, replays the last N
acts this seat could see (team-wide and addressed to ryder, from this machine's database) through
each build's own tool handler behind a fake client, and counts the characters of the reply. Claude
Code hands the model the structured form, so both are shown.

| Acts in the unread tail | text before → after | structured before → after |
| --- | --- | --- |
| last 20 | 5,063 → 4,463 (−12%) | 2,878 → 2,145 (−25%) |
| last 50 (the default `limit`) | 11,901 → 10,204 (−14%) | 6,507 → 4,437 (−32%) |
| last 200 (a backlog; 50 shown, the rest digested) | 30,244 → 12,308 (−59%) | 9,863 → 4,778 (−52%) |

An ordinary check shrinks 12–32%; the large effect is on a backlog, where the old reply was at its
30,000-character cap and the new one is at 12,000. Limits of this method: the acts are the last N
this seat could see treated all as unread, which is not what a live cursor produces, and the board
read that decides which lane acts are folded is stubbed empty. It is a replay of real bodies and
meta, not a live telemetry reading.

## Hot tools (#2476)

`tools/list` grows by 152 bytes (table above). Whether the first musterd call skips a schema-search
turn is a yes/no per host, not a number: Claude Code reads `_meta anthropic/alwaysLoad`; grok: yes;
codex: no (`mcp-stdio-bench.md`); Cursor's docs show no per-tool control.

## Not measured

- Startup before ADR 584 beyond the ladder above.
- The wake-lease poll over HTTP on the hub itself, and the hub's daytime tail (wallow's lane
  `01M4YY5Z38`).
- Reply bytes from live checks: no telemetry exists, so the replay above stands in.
- The `team_inbox_check` average of 3.5 s and `team_send` 1.4 s in the same report: those include
  blocking waits and are not a speed measure of the adapter.
