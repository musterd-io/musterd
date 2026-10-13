# 573 — Every team-wide roster read is shared across a team's viewers for 1 s (cloud)

- Status: accepted
- Date: 2026-10-12
- Deciders: fifty (lane `01M4GQ3CQV4HGKDFHZDCPGF1A2`), nick (the cloud perf goal; ADR 541's 1 s window)
- Relates to: ADR 541 (two of these reads shared; this widens it, the same window and rules), lane
  01M4GQ2G7B (the roster's style-epoch memo), lane 01M3Z4EMH3 (a second app machine)

## Context

ADR 541 shared two of the statements in `summarize`, the status clock and the quiescence fold,
across a team's viewers for 1 s. The rest of a `GET /teams/:slug` still read the store on every
request: the team row, the seats in reclaim grace, the residency facts, the residences and the
local node, the live drivers, the team style policy and the presence roster. That is nine reads,
each its own transaction on Postgres, and none of them depends on who is reading.

The run 28 plateau CPU capture (`docs/perf/daemon-load-baseline.md`) put the app core at about 97%
busy: pg row decode 13%, GC 11%, transactions 7.6%. In run 31 (2026-10-12) the roster was 26 671
of 58 511 requests, about 20 a second on one team, and its p95 was 1 864 ms against a 1 000 ms
budget. The memo of lane 01M4GQ2G7B did not move p95 beyond the run-to-run spread.

## Problem

Each viewer's poll decodes, in about nine transactions, the same rows every other viewer of the
team decoded less than a second ago. ADR 541 already accepted a 1 s window for two of them. Should
the window cover the whole team-wide set, and what must stay exact?

## Decision

1. **In cloud mode, every team-wide read of the roster is one shared load per team.** The load
   covers the team row, reclaim grace, residency facts, residences, live drivers, the status
   clock, the quiescence fold, the style policy and the presence roster. ADR 541's rules hold for
   all of it: one load serves every roster read of that team for **1 s** from when it started, a
   read during a load joins it, and nothing is served past the window.
2. **Per-viewer work stays per request.** The viewer's auth, `capabilities`, `can_halt` and the
   row projection are computed for each request, as before.
3. **A route that has just written reads fresh.** A handler that changes a member and returns that
   member's roster row (`POST /availability`, the hue route) bypasses the shared load, so a caller
   always reads its own write back.
4. **A local daemon is unchanged.** It reads straight through on every request.

## Consequences

- A presence change, a join, a residency change or a style change can reach a viewer up to 1 s
  late, the same delay ADR 541 accepted for statuses. `/live` refetches on presence frames, so the
  delay is at most one window per change.
- At about 20 roster reads a second per team, the roster's store reads fall from about 9 per
  request to at most 9 a second per team. Row decode, GC and transaction work on that path fall by
  the same ratio, and the 151 KB body is still built and compressed per request.
- The shared value is read-only to its callers. A caller that mutates it would change the roster
  for every viewer for up to a second.
- Falsifier: on the next unprofiled 75/75/75 run on `performance-1x`, if the roster's p95 does not
  fall below run 31's 1 864 ms by more than the ±8% spread, the store reads were not the cost.

## Observability & Evaluation

- **Traces:** n/a — this is server read serving, not agent behaviour.
- **Eval:** the dataset is the load-run population (ADR 451's 75 humans, 75 agents and 75
  viewers). The baseline is runs 29 and 31 on `daeb0a3`: `GET /teams/:slug` p95 1 623 and
  1 864 ms, all-request p95 1 613 and 1 872 ms.
- **Experiment:** an unprofiled run on a build with this change, on the same Neon 1 CU and app
  machine size. The falsifier is under Consequences.
