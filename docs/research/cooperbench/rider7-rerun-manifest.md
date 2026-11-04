# CooperBench rider 7 re-run: pre-registration

**Lane:** `01M6MDRD86` (this page and the wake guard), goal `coordination-cost`, asked by nick ("write
the manifest for the re-run", 2026-11-04 in session). The run is its own lane once spend is approved.
**Status:** pre-registered 2026-11-04, before any pair ran on the ADR 804/805 build. Nothing below
changes once a measured pair has run. **CooperBench:** `63b9d44`. **Before this:** [rider 7
manifest](./rider7-manifest.md) → [finding 031](../031-cooperbench-rider7-smoke.md), stopped at the
smoke pair; [ADR 804](../../decisions/804-wake-report-releases-the-reclaim-hold.md) and
[ADR 805](../../decisions/805-resume-price-bound.md), the two fixes it produced.

## Why

Finding 031 proved the act-lane arm's wiring (15 wakes, 13 resumed, 0 failed) and stopped on two
costs the first run had no bound for: a resumed wake paid for the whole transcript every time ($0.17 →
$1.64 a wake), and every act waited out the previous wake's 45 s reclaim hold plus the spawn cycle
(24 s → 5m42s). Both are now product: ADR 804 ends the hold at the wake report, ADR 805 refuses a
resume that would re-ingest more than `resume_max_usd`. The arm sets that bound at $0.25
(`team.py`, `ACT_LANE_POLICY`). Rider 7's question — does the inverted loop replace the waiting turns,
at what cost, and how fast does the host wake a seat — is still unread.

## Rules

[Rider 7](./riders.md#rider-7-finding-028s-loop--the-musterd-arm-on-the-act-lane-where-a-seat-ends-its-turn-and-the-host-wakes-it-on-the-next-act)'s
rules and bounds, unchanged, quoted so the documents cannot drift:

| | Count | Finding 028 (`core`) | Acted | Did not |
| --- | --- | --- | --- | --- |
| R7a | turns spent waiting: wait-mode `team_inbox_check` calls plus wakes | 90 (+ 0 wakes) | **≤ 55** | **≥ 75** |
| R7b | model dollars, 10 pairs, first call plus every wake | $18.45 | **≤ $15.00** | **≥ $18.00** |
| R7c | act→wake wait, median over wakes with a `waited_ms` | — | **≤ 2 min** | **≥ 15 min** |

Between the bounds: "part of it". R7c "did not" voids R7a and R7b as reads of the lane. R7b is read
against finding 028's ten pairs; a run of fewer pairs (below) reads R7b per pair against $1.85, with
the same bounds scaled ($1.50 / $1.80 a pair), and says so.

Beside them, with no rule, two numbers finding 031 adds: **wakes that spawned fresh because of the
price bound** (host log: `resume would re-ingest …` / `resume price unknown …`), and each wait's
`reclaimable` share from the holds (expected near zero after ADR 804; its Eval).

## Arm

One arm, musterd only, on the act lane, exactly as the [rider 7 manifest](./rider7-manifest.md#arm)
names it (`MUSTERD_ARM_LANE=act`, `claude_code_musterd`, Claude Code 2.1.307, `claude-sonnet-4-5`,
`core`, `--git`, `-c 3`), with three differences, each a product or arm change since:

| Piece | Rider 7 (11-04) | Re-run |
| --- | --- | --- |
| Daemon | `7c024748` | `main` at or after #3853 (ADR 804 + 805) |
| Team residency policy | `lane act`, `hourly_cap 60`, `timeout 60m`, `transcript_max 256 MiB`, `tool_policy seat-policy` | the same plus `resume_max_usd 0.25` |
| Spend guard | `spend_guard.py` over finished `result.json` only | plus `wake_guard.py`: every 30 s, the priced wakes of every live pair from its daemon's database; stop at **$6 of wakes in one pair** or at the hard stop overall, killing the arm as `run_arms.py` would |

The instruction, settings, enrollment and run shape are rider 7's. Nothing is added for the
benchmark.

## Tasks

CooperBench's 10 `core` pairs, or the first five in `core.json` order if nick funds the smaller run
(below). Pair for pair against findings 025–028.

## Spend — a decision for nick

Finding 031 gives the only act-lane prices there are: first calls $3.15 a pair (two agents), 15 wakes a
pair, and a fresh wake at $0.17–0.31. With the bound, a wake is at most $0.25 of re-ingestion plus its
own work, so about $0.30–0.45; fifteen of them is $4.50–6.75. **About $8–10 a pair**, against rider
6's $1.85. ADR 804 should cut the wait, not the count: the wakes are the agents' turns.

| Run | Pairs | Model spend | Hard stop |
| --- | --- | --- | --- |
| A — full | 10 `core` | $80–100 | **$110** |
| B — half | 5 `core` (first five) | $40–50 | **$55** |

Either reads R7a and R7c in full. R7b under B is a per-pair read. The smoke pair (step 4) is counted
in the stop. If the smoke pair's wake spend is under $3, the estimate above is high and the run is
likely to land under the low end.

## Errors

As the rider 7 manifest: an error is re-run once under a new name with its reason recorded; a failed
score never; three errors in the first three pairs stop the arm; a pair where a wake was due and never
leased is an error; `spend_guard.py`'s API-limit stop and `wake_guard.py`'s stops end the run, and
the pairs that ran are a partial run, stated as such.

## Procedure

On `musterd-cooperbench`, in one session, the deploy token already on `musterd-joiner-1` (expires
2026-11-06 ~21:00Z) or a new one.

1. **Deploy** from `main` at or after #3853; after the deploy `useradd smoke`, `mkdir -p` + `chmod
   1777` the swe_agent `trajectories` directory, the `dataset` symlink.
2. **API check**, then **smokes** as the `smoke` user: `gate_smoke.py`, `hold_smoke_697.py` PASS.
3. **Wake guard dry read:** `wake_guard.py --once` against an empty glob prints zeros.
4. **One smoke pair** (`pallets_click` 2068, `MUSTERD_ARM_LANE=act`) under `wake_guard.py --pair-cap 6`:
   it must show wakes leased, at least one `resume would re-ingest …` line once the transcript passes
   the bound, `reclaimable` under 5 s per wait in the pair's residency report, and both patches. A
   smoke pair that still shows `reclaimable` tracking 45 s, or a resume past the bound, stops the run
   until the cause is fixed on `main`.
5. **Pull** the images, **run the arm** `-c 3` `--no-auto-eval` under `run_arms.py --cap <hard stop>`
   with `wake_guard.py --pair-cap 6 --total-cap <hard stop> --finished /data/runs/logs --runs 'r7b-*'`
   beside it, then `cooperbench eval --backend docker`.
6. **Re-run errors once**, copy `readout.json`, the run log, each pair's `host.log` and
   `musterd-residency.json`, the residue scripts' output, `rider5.json`, `rider7.json` and the guard's
   log into `docs/research/cooperbench/pilot-runs/<date>-rider7b/`, and `fly machine stop`.
7. **Read R7a, R7b, R7c** under the rules, write finding 032, revoke the deploy token.

## Decisions

| Decision | Answer |
| --- | --- |
| Re-run under rider 7's rules, unchanged | this manifest; the rules are the pre-registered ones |
| ADR 804 + 805 on the build; `resume_max_usd 0.25` | the two lanes finding 031 opened, landed 2026-11-04 |
| A live wake guard, $6 a pair | this manifest, from finding 031's $14.34 unseen by the spend guard |
| Pairs and hard stop (A: 10 / $110, B: 5 / $55) | **nick — pending** |
| Finding number | 032 |
