# MCP fast path: what each cut bought, measured against one baseline

Lane `01M562HNQF47JM32EAVVHZMTAA` (goal `live-loads-fast`). The speed changes under TJ's
`mcp-fast-path` goal were each measured alone, on different machines and loads. This page puts the
cold-start ones on one machine, in one run, interleaved, so they can be read against each other.

## Cold start, by change (2026-10-17; falsify: re-run the command below on a machine with a 1-minute load under 8 and put the A→E wall-time drop outside 25–45% with `/health` instant, or outside 50–70% with `/health` delayed 300 ms)

Time from the adapter's process start to its `tools/list` reply (31 tools every run), median of
25 launches per ref, the refs launched round-robin and the order reversed each round. Apple M3,
8 CPU, 8 GiB, node v22.23.3, darwin/arm64. **The machine was busy: 1-minute load about 10 on 8 CPUs**, so
read the medians, and the ranges overlap between neighbouring rows.

| Ref | What it is | wall, `/health` instant | CPU, instant | wall, `/health` +300 ms | CPU, +300 ms |
| --- | --- | --- | --- | --- | --- |
| A `3da54a0c` | before the bundle (parent of #2435) | 381.9 ms (300–485) | 461.2 ms | 873.7 ms (639–1075) | 515.8 ms |
| B `1471ab70` | #2435 bundle the harnesses launch (ADR 574) | 274.9 ms (225–371) | 270.5 ms | 703.0 ms (542–1091) | 315.3 ms |
| C `1cbd1e65` | #2458 compile cache (ADR 577) | 248.9 ms (208–298) | 245.7 ms | 668.2 ms (529–945) | 288.3 ms |
| D `faa60d3a` | #2474 serve initialize without waiting on `bind()` | 234.7 ms (184–312) | 239.4 ms | 371.2 ms (220–582) | 280.0 ms |
| E `de597545` | `main` on 2026-10-17 | 250.4 ms (203–337) | 256.1 ms | 339.7 ms (221–551) | 282.0 ms |

Step by step (wall / CPU, change in the median):

| Change | instant `/health` | `/health` +300 ms |
| --- | --- | --- |
| A → B, the bundle | −28.0% / −41.3% | −19.5% / −38.9% |
| B → C, the compile cache | −9.5% / −9.2% | −4.9% / −8.6% |
| C → D, initialize without `bind()` | −5.7% / −2.6% | **−44.4%** / −2.9% |
| D → E, everything since | +6.7% / +7.0% | −8.5% / +0.7% |
| **A → E, the whole set** | **−34.4% / −44.5%** | **−61.1% / −45.3%** |

What the table says:

- **The bundle (#2435) is most of the CPU win**, about 41% of the process's own work.
- **#2474 is a wall-time win only when the daemon is slow to answer `/health`.** With an instant
  stub it is −5.7% and inside the noise; with a 300 ms `/health` it removes the wait (−44%). A
  fast local daemon hides it, which is why the CI check (instant stub, CPU time) cannot see it.
- **The compile cache (#2458) is real but small** here, −9.5%, with overlapping ranges.
- **D → E reads slightly up with an instant `/health`** (+6.7% wall, +7.0% CPU). The ranges overlap
  and the load was high, so this is not shown to be a regression; it is inside the CI gate's +10%
  (`docs/perf/mcp-startup-budget.json`). Re-run on a quiet machine before calling it one.
- **First launch** (the harness's first, with a cold compile cache), instant `/health`: A 435.5 ms
  → E 296.4 ms wall.

Reproduce: `node scripts/mcp/ladder.mjs "$PWD" 25 A=1471ab70^ B=1471ab70 C=1cbd1e65 D=faa60d3a
E=origin/main`. It builds each ref in a scratch worktree (`pnpm install --frozen-lockfile --filter
@musterd/mcp...` then build), stands a stub in for the daemon's `/health`, and sets no
`NODE_COMPILE_CACHE` so the adapter's own cache is part of what is measured. The raw per-ref
medians, minima and maxima are in the tables above.

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

## Other changes in the set

| Change | Before → after | How known | Re-measured here |
| --- | --- | --- | --- |
| Wake-lease poll (#2511, planner stats re-analyzed) | 2.3–3.1 s → 0.12–0.34 s on the hub | the PR, 2026-10-13 | **No.** This machine's daemon log starts 2026-10-16, after the fix, and its database is a joiner's replica, not the hub's: the poll here is p50 357–360 ms, p90 436–453 ms (14,201 polls, 10-16 and 10-17). wallow's lane `01M4YY5Z38` is on the hub's daytime tail (p90 0.8–1.1 s). |
| `team_inbox_check` default reply (#2517) | cap 30,000 chars → 12,000; body clip 1,200 → 600; the median check was 4,169 chars (241 checks) | the PR and `05-mcp.md` | No. The caps are exact; no reply-size telemetry exists to read a live after. |
| Hot tools without a schema search on Claude Code (#2476) | `_meta alwaysLoad` on 4 tools, +152 B on `tools/list` | `context-budgets.json` | A yes/no per host, not a number. grok: yes. codex: no (`mcp-stdio-bench.md`). |

## Not measured

- Startup before ADR 584, other than by the ladder above.
- The wake-lease poll before and after on the hub: that needs the hub's log or database.
- Reply bytes after #2517, live.
- The `team_inbox_check` average of 3.5 s and `team_send` 1.4 s in the same report: those include
  blocking waits and are not a speed measure of the adapter.
