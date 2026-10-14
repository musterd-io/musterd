# 587 — A forwarded policy change carries the copy it was built on, and the hub refuses a stale one

- Status: accepted (2026-10-13, nick, in chat: "yes go ahead with base check and its adr")
- Date: 2026-10-13
- Deciders: nick, wallow
- Lane: `01M4PGJ1A5XTKSXHSXQA8TRQ88`
- Amends: [ADR 185](185-sparse-team-policy.md) (replace semantics) and the residence-2 policy
  forward (`POST /sync/policy`, [ADR 367](367-team-policy-is-the-hubs-and-replicates.md)) for a forward from a joiner only. Replace semantics stand.

## Context

Team policy is stored as a sparse override and written with replace semantics (ADR 185): `POST
/policy` stores the doc it receives, and a key the doc leaves out is unset. Every CLI writer
(`team policy`, `policy style`, `doorbell`, `residency`) therefore reads the stored doc, changes
its own knobs, and sends the whole doc back.

Policy is hub-authoritative (ADR 325 residence 1). An admin on a joiner sends the request to the
joiner's daemon. The joiner forwards it to the hub (`policyAtHub`, `POST /sync/policy`), and the
hub stores it and replicates a `policy.change` that every machine folds. The doc the CLI read and
merged into is the joiner's local copy. Nothing checks that copy against the hub's.

On 2026-09-06 at 01:59 UTC the revive hub logged `policy.change {"loops":{"dispatch":true}}` as
nick, forwarded from a joiner that had not yet folded the hub's policy. The hub's stored doc before
it held `loops` (review and sweep on), `standing_reseat_known_agents`, the seeds relay URL and
token, and `stakes_defaults`. The write unset all of them. Review wakes stopped (the last one was at
00:35 UTC that day, after 159 before). The other knobs were set again by hand over the next weeks;
`stakes_defaults` was never restored, and is restored alongside this change (2026-10-13).

## Problem

A forwarded change is a whole doc built on a copy the hub never sees. When that copy is behind the
hub's, replacing with it silently unsets whatever the copy lacked. The hub has no way to tell a
deliberate unset from a stale base, and it does not record how far each joiner has synced.

## Decision

1. `SyncPolicyRequest` gains an optional `base`: the stored override the forwarding machine held
   when it took the request. A joiner sends its own stored doc, which is the copy the admin's
   client read.
2. The hub compares `base` with its own stored doc inside the write's transaction. If they differ,
   it refuses with `conflict` (409) and writes nothing. The message tells the admin the change was
   built on an old copy and to run the command again.
3. The joiner relays the hub's `conflict` and pulls from the hub before it answers, so the admin's
   retry reads and merges into the hub's doc.
4. A forward with no `base` comes from a joiner on an older build. The hub accepts it as before and
   logs `sync_policy_without_base` with the node id, so the last such forwarder can be found before
   `base` is ever made required.
5. Replace semantics are unchanged. A merge on the hub was rejected because leaving a key out is how
   an admin unsets it (ADR 185): a hub that merged could not tell an unset from a stale base either.

## Consequences

- A joiner cannot unset a hub knob it has not seen. It can still unset one it has seen, which is
  what replace semantics are for.
- Two admins writing on the same machine are not covered: both read the same row, so the second
  write replaces the first. That is the single-machine behaviour ADR 185 already has; it is not
  this change.
- A refused change costs the admin one retry after the pull. A joiner whose pull fails gets the
  same refusal again, which is correct: it is still behind.
- The comparison is exact (`isDeepStrictEqual` on both stored docs parsed by `PolicyOverrideSchema`).
  The fold copies the hub's stored doc as is (`projectPolicyEvent`), so a joiner that has synced
  holds an equal doc, including `review_by`.

## Observability & Evaluation

- **Traces:** the refusal is an HTTP 409 `conflict` on `POST /teams/:team/sync/policy` in the hub's
  `http_request` log and a 409 on the joiner's `POST /policy`. A forward without `base` logs
  `sync_policy_without_base` on the hub.
- **Eval:** `packages/server/src/sync/policy.test.ts` replays 2026-09-06 between two real daemons.
  The hub holds review and sweep; a joiner with an empty copy forwards `{loops:{dispatch:true}}`
  and is refused with the hub's doc unchanged; the retry after the pull leaves all three loops on.
- **Experiment:** n/a. The falsifier on the live team: a `policy.change` on the hub whose doc lacks
  a key the previous one held, where the forwarding joiner's build includes this ADR and no admin
  ran an explicit unset.
