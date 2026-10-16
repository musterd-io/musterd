# 622 — Per-team rate limits

- Status: accepted
- Date: 2026-10-15

## Context

Cloud design spec 2026-09-29 §5 item 4 requires per-team rate limits and quotas, at the edge and in
the server. Increment 1C left that out of its acceptance (plan 2026-09-30, decision 6) and recorded
it as lane `01M3W3EQ67`. Host isolation already answers which team a request may name. The shared
pool already answers a saturated server with `503` "database pool exhausted" (lane `01M3ZC3G35`).
Nothing sheds one team's flood before that pool is asked.

## Problem

On Cloud every request arrives from the edge. A budget keyed by peer IP is one bucket shared by
every team behind that edge, or a bucket a caller rotates by changing the header. A flood that
checks a client out of the pool holds that pool for every other team. The OAuth per-IP buckets
(ADR 446) count a different thing — one route, the client IP the edge stamps — and are the wrong
tool for a team budget.

## Decision

1. **Cloud only.** The check runs when `config.cloud` is set. Self-hosted has no cloud block, and
   the budget does not run there.
2. **The key is the team slug.** HTTP charges `pathTeam` after host isolation and after the
   affinity replay (ADR 608), so a non-owner has already handed the request off and only the owning
   machine counts. A WebSocket upgrade charges `hostTeam` in the same place, on the same map. A
   global route has no path team and is not charged. On Cloud a claim whose team differs from the
   host team is already `not_found`, so the upgrade charge is the team the socket can join.
3. **600 requests per 60 seconds**, a sliding window. `MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN` overrides
   it with a positive integer read in `resolveCloudConfig`. It is not one of the variables cloud
   mode refuses to start without.
4. **Over budget is `429` `rate_limited`**, `Retry-After: 60`, message "too many requests for this
   team — retry in a minute". The message does not include the slug. The check is synchronous and
   throws before any store checkout. A denial records no hit.
5. **An unknown slug still takes a key** before the team is known to exist, so an over-budget scan
   of one slug never reaches the store. The map holds at most 10,000 keys: expire empty windows,
   then evict the oldest key. Same bound as the OAuth buckets. Those buckets are unchanged.
6. **The edge half is a checked-in Cloudflare rate limiting rule**,
   `deploy/cloud/per-team-rate-limit.json`. Characteristics are `http.host` and the mandatory
   `cf.colo.id`. `cf.colo.id` is not in the expression. `ip.src` is in neither: it would split a
   team by client, or merge teams that share an address. The count is the same 600 per 60 seconds.
   The action is `block` with status 429 and the same JSON body. `mitigation_timeout` is 60 because
   a block with timeout 0 (throttle for the whole period) is Enterprise-only; a positive timeout
   blocks for that long once the rate trips. Counters are per data center and not exact, so the
   server window is the precise budget. This change checks the rule in. It does not post it.
7. **The quota this decision ships is the request budget.** Seat count and stored bytes are outside
   this decision.

## Consequences

- One team's over-budget requests return before `connect()`, so they do not hold a pooled client.
  Another team's request still checks a client out.
- A new slug is admitted once and checked out once. The key cap then evicts the oldest key. Memory
  stays bounded. A scan of distinct new slugs still reaches the store once per slug.
- The edge counter and the server window can disagree, by colo and by the 60-second block. The
  server is the line that holds.
- The edge expression matches every single-label host under `musterd.dev`, including the health
  check host `health.musterd.dev`. That host has a separate counter. The server does not charge
  `/health`. The check interval is far under 600 a minute.
- `rate_limited` now also names this budget (SPEC A.8). No new error code.
- 600 is the pin in code and in the rule. A rehearsal sets `MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN`.

## Observability & Evaluation

Traces: the existing `http_request` line records method, redacted path, and status, at warn for a
429. A refused upgrade logs `ws_upgrade_rejected` with `reason: rate_limited` and does not log the
slug.

Eval: `packages/server/src/cloud/teamBudget.test.ts`. The dataset is one team over its budget while
another team's request is admitted, and the denied request does not call `connect`. The baseline is
the shared pool with no per-team shed (lane `01M3ZC3G35`), where one team's checkouts stall every
team.

Experiment: not run. A flood of one team host on staging, timed against a second team's route,
shows a miss if the second team slows or returns `rate_limited`.
