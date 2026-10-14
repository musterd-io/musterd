# 593 — A forwarded policy change with no base is refused

- Status: accepted
- Date: 2026-10-14
- Deciders: wallow, lazara (review of #2540)
- Lane: `01M4PGJ1A5XTKSXHSXQA8TRQ88`
- Amends: [ADR 587](587-forwarded-policy-change-carries-its-base.md) Decision 4

## Context

ADR 587 made a joiner send its stored policy doc as `base` with a forwarded change, so the hub can
refuse a change built on a stale copy. Decision 4 kept a forward with no `base` working: it came
from a joiner on an older build, and the hub accepted it and logged `sync_policy_without_base`.

lazara declined the outcome of #2540 on 2026-10-13. A forward with no `base` is still stored as
given. That is the 2026-09-06 write: `{loops:{dispatch:true}}` from a stale joiner still unsets
`loops.review` and `loops.sweep`.

## Problem

Decision 4 leaves open the path that caused the incident, for as long as any joiner runs a pre-587
build. The log line tells us after the damage, not before it. The cost of the two failures is not
equal. A refused change is one loud error that a refresh fixes. A silent unset turned review wakes
off for weeks.

## Decision

1. The hub refuses a `POST /sync/policy` that names no `base`, with `conflict` (409). It writes
   nothing, and its message tells the admin to update musterd on that machine and run the command
   again. It still logs `sync_policy_without_base` with the node id.
2. `conflict` because a pre-587 joiner relays that code (with the hub's message) and turns any
   other unknown code into a fault.
3. `SyncPolicyRequest.base` stays optional in the protocol schema. A required field would refuse
   the old build with a parse error that does not say what to do. No protocol change.
4. No merge on the hub. ADR 587 Decision 5 holds: a hub that merged could not tell an unset from a
   stale base (ADR 185).

## Consequences

- An admin on a joiner that has not refreshed since #2540 cannot change policy until it refreshes.
  Every machine on revive auto-refreshes from `main`, so the window is one refresh tick.
- The only way left to write the hub's policy from a joiner is with a `base` that matches the hub's
  stored doc.

## Observability & Evaluation

- Traces: `sync_policy_without_base` (warn, with node id) is logged on each refusal.
- Eval: `packages/server/src/sync/policy.test.ts` — a forward with no base gets 409 and leaves the
  hub's stored doc unchanged.
- Experiment: n/a — a correctness refusal, not a behaviour to compare.
