# 541 — The roster's team-wide reads are shared across a team's viewers for 1 s (cloud)

- Status: accepted
- Date: 2026-10-06
- Deciders: nick (chose the 1 s window), fifty (lane `01M49MEFFRNKSZ0KAYXVY96BTR`)
- Relates to: lane 01M3ZCTQK9 (the roster's statements are constant in team size), the
  `reportCache` single flight (lanes 01M3D4069F, 01M3ZCTQ77), ADR 219 (quiescence)

## Context

`GET /teams/:slug` builds the roster in `summarize`. Two of its statements are the same for every
viewer of a team: every member's latest status (`latestStatusUpdates`) and the quiescence fold
(`lastActionBySubject`). In load run 18 (2026-10-06, `docs/perf/daemon-load-baseline.md`), 75
viewers read one team's roster about 17 times a second. Those two statements averaged about 29 and
31 ms and used about 1 380 s of the roughly 1 960 s the Neon 1 CU compute spent on its top
statements in a 1 300 s run. The compute was saturated, and p95 was 3.3 s against a 1 s budget.

## Problem

Each viewer's poll recomputes two answers that every other viewer of the team has just computed.
The roster is how `/live` shows who is working, so serving it older than it is today trades
freshness for capacity. Which trade should Cloud make?

## Decision

1. **In cloud mode, the two team-wide roster reads are shared per team.** One load serves every
   roster read of that team for **1 s**, counted from when the load started. A read that lands
   while a load is running joins it.
2. **Never served stale.** Past the window a reader waits for a fresh load. There is no
   stale-while-revalidate, unlike `/report`, so the roster is never more than 1 s old.
3. **Per-viewer fields stay per request.** `capabilities` and `can_halt` depend on who is reading
   and are computed for each request as before.
4. **A local daemon is unchanged.** It reads both statements on every request: a handful of
   viewers, and tests that write and then read at once.
5. **Loads run on the requesting request's team-scoped handle**, so RLS holds, and a value is only
   ever handed to readers of the same team.

nick chose the 1 s window over two alternatives: a zero window (join overlapping loads only, which
keeps exact freshness but saves only the loads that overlap) and no change (buy a larger Neon
compute instead).

## Consequences

- A new `status_update` or a seat's busy/quiet change can reach a viewer up to 1 s late. `/live`
  already refetches on presence frames, so the delay is at most one window per change.
- At about 17 roster reads a second, the two statements fall to at most 2 loads a second per team.
- The window is a constant (`ROSTER_SHARED_TTL_MS`), not a team policy. Making it one is a later
  decision, if a team needs exact freshness under load.
- Falsifier: on the next load run, if those two statements still make more than about 2 calls a
  second per team, or roster p95 does not fall, the sharing is not taking effect.

## Observability & Evaluation

- **Traces:** n/a — this is server read serving, not agent behaviour.
- **Eval:** the dataset is the load-run population (ADR 451's 75 humans, 75 agents and 75
  viewers). The baseline is run 18's `pg_stat_statements` for queryids 163881676154281294 (status
  clock) and 7225204380229572402 (quiescence fold), and its roster p95 of 3.4 s.
- **Experiment:** the next load run on a build with this change, on the same Neon 1 CU and app
  machine size as run 17. The falsifier is under Consequences.
