# 490 — Durable review promises derive from accepted request Acts

- Status: accepted
- Date: 2026-09-30
- Deciders: nick (selected the conversational carrier)
- Spec: `docs/superpowers/specs/2026-09-30-durable-review-promises-design.md`
- Relates to: ADR 025 (`resolve` closes a thread), ADR 090 (derived Act ledger), ADR 233 (Lane acceptance in `NextBrief`), ADR 254 (eligible sets)

## Context

An accepted `request_help` that asks for a review has no typed relation in the working Member's
`team_next` brief. The `accept` discharges the request's open inbox loop, and the original Act stays
in the ledger, but no structured field keeps the accepted review visible at later task boundaries.
`owed_reviews` and `review_debt` both describe Lane acceptance and cannot represent a promise made
on a standalone request.

The conversational design selected by nick on 2026-09-30 is to derive the reminder from the
accepted request Acts. Nick approved the written design on 2026-10-01; implementation planning is
the next review boundary.

## Problem

The accepted Act is both the agreement and the only durable record of what was agreed. Treating its
acceptance as completion loses the work the responder promised to do. A separate obligation row
would copy the request, answer and close facts already present in the Act ledger, then need rules to
keep that row synchronized.

## Decision

1. A review request is a root `request_help` Act carrying a discriminated `meta.review` artifact
   reference: a PR (`repo`, `number`), commit (`repo`, `sha`, optional `path`), Lane (`id`), or
   HTTPS URL without userinfo or query string. Its body supplies the human-readable review context.
2. A typed review request addresses exactly one Member; Team targets and eligible sets are not
   supported in this increment. Only the direct recipient's `accept` with `meta.in_reply_to`
   referencing the request creates a promise, owned by that recipient. A direct recipient's
   `decline` creates no promise; duplicate accepts derive one row. The `accept` sets `thread` to the
   root request Act id.
3. Derive open promises from the typed request, its accepted reply and the absence of a `resolve` on
   the root thread. Surface the promise in additive `NextBrief.request_reviews` for the owner and
   `NextBrief.requested_reviews` for the requester. Both carry the request id, requester, owner,
   original context, artifact reference and acceptance time; include every matching open promise,
   oldest acceptance first, with request id as the stable tie-breaker. Keep these separate from
   `owed_reviews` and `review_debt`.
4. When duplicate direct accepts exist, select the earliest `(ts, id)` pair. Its `ts` is
   `accepted_at`; it is the sender's clock, not server receipt time. The direct request target fixes
   the owner, so replicas choose the same accepted Act without a cross-daemon owner arbitration
   rule. A `resolve` on the root thread closes both open rows under existing semantics; any Member
   may resolve it, including the requester withdrawing the request. The closing `resolve` is
   Team-addressed so both parties receive it, and it names its sender. If someone other than the
   owner closes it, add one owner-side `NextBrief.review_closures` notice until the owner's inbox
   cursor crosses that `resolve` Act. The promise is a reminder, not proof that review content or
   quality was verified.

Deriving from the Act ledger uses the existing closure Act and avoids a second source of truth. A
Lane per short review would couple the promise to Lane acceptance; a new obligation store would
duplicate the Acts; retaining no state would leave the accepted work invisible. The design spec's
§5 records these alternatives.

## Consequences

- The server derives the reminder; no obligation table, new Act, timer, dependency or review-quality
  check is added.
- The three brief fields are optional and have no schema defaults. An older daemon's omitted fields
  remain absent after `NextBriefSchema.safeParse`; a capable daemon emits all three arrays, including
  empty ones. Renderers label an absent section unsupported and show it as empty only for `[]`.
- The root-thread requirement keeps a resolve scoped to this review request. Existing `resolve`
  authority means another Member can close it; the Act ledger records who did, and the owner gets a
  one-time notice when that was someone else.
- On a federated Team, each brief reflects the Acts present in that daemon's replicated ledger; this
  projection adds no cross-daemon read-after-write barrier.
- Protocol fields remain unreleased until specified in the single `SPEC.md` Appendix A and gated by
  this ADR plus the protocol feature epoch. Lane 3 of `nothing-vanishes` landed at epoch 27; the
  implementation must allocate the next epoch from its current base.

Follows-up: update and review the implementation plan after the A.14 amendment is accepted (Lane
`01M3TBW5QPKY76FTV9SAGM8MBZ`); implementation waits for plan approval.

- Dated note (2026-10-01): Nick approved the written design. The implementation plan is awaiting
  review; no implementation has started.
- Dated note (2026-10-01): review of the implementation plan found that the scheduled `sweep`
  Member cannot obtain the Team-wide population from per-caller `NextBrief.requested_reviews`.
  The design spec and SPEC A.14 now add a member-authenticated Team read for open promises with
  only request id, requester, owner, and acceptance time; the audit abstains when that route is
  unsupported and treats a supported empty list as zero open promises.

## Observability & Evaluation

**Traces.** No new trace event. The request, accepted or declined answer, and thread closure are
already Acts in the ledger; the promise is a derived projection.

**Eval.** Dataset: deterministic Act sequences for direct-recipient review requests with accept,
decline, duplicate answer, owner close and non-owner close cases, plus rejected Team/eligible-set
forms. Baseline:
`NextBrief` has no review-promise field, so zero accepted standalone review requests are surfaced
there today. Success means every accepted unresolved typed request appears for its owner and
requester, oldest first; a duplicate answer creates one promise; no declined, unaccepted or untyped
request appears; a non-owner close is noticed once by the owner until their inbox cursor crosses the
`resolve` Act; a resolved thread disappears from both open lists; and existing Lane acceptance
fields are preserved.

**Experiment.** None — this is a deterministic protocol projection. The implementation's boundary
and store tests are the appropriate validation.
