# Durable review promises — design

- Date: 2026-09-30
- Author: big-body (lane `01M3TBW5QPKY76FTV9SAGM8MBZ`), in coordination with dolly
- Goal: `nothing-vanishes`
- Status: conversational design approved; written design awaiting review
- Decision record: ADR 490 (reserved; body not yet written)

## 1. Outcome

When a Member accepts a typed `request_help` that asks for a review, the promise remains visible in
that Member's `team_next` brief until its request thread is explicitly resolved. The accepted Act
identifies who owns the promise; the original request identifies what is to be reviewed; a `resolve`
on the request thread closes it under the existing thread-close semantics.

This closes the gap between a request being accepted and the review work being finished. An `accept`
currently discharges the request's open inbox loop, while no structured state remains for `team_next`
to display.

## 2. Boundaries

- Applies only to an explicitly typed review request. Generic help requests keep their existing
  accept/decline lifecycle.
- This is a reminder and record of the accepted promise. It does not verify the content or quality of
  a review.
- Lane acceptance remains separate: `owed_reviews` is still work assigned by an acceptance ask, and
  `review_debt` is still the ambient queue of Lanes awaiting acceptance.
- It does not set or change ordinary pre-merge GitHub review policy.
- A request that has not been accepted remains an inbox request, not an accepted promise.

## 3. Current lifecycle

`request_help` is a loop-opening Act. An `accept` with `meta.in_reply_to` discharges that loop. The
message stays in the Act ledger, but the current `NextBrief` has no typed relation representing
review work accepted from that message. `owed_reviews` and `review_debt` are derived from Lane
acceptance state, so they cannot represent this case.

The `resolve` Act already closes a thread. A root request Act's own id is the thread id, and the
existing protocol recommends that replies carry that thread id. This gives the accepted promise a
completion edge without a second store.

## 4. Chosen carrier: derive from the Act ledger

1. A review `request_help` carries a typed `meta.review` object with a stable, credential-free
   artifact reference; it must not embed a credential or signed access token. The request body
   remains the human-readable context. It is a root Act with no existing `thread`, so resolving it
   closes only this review request. A request without this marker is unchanged.
2. A review request must name one Member directly or use a Team `meta.eligible` set. A plain Team
   request is not allowed for this typed form because it has no bounded owner set.
3. Only an answer from the direct recipient or a Member in the eligible set may settle the typed
   request. The first such `accept` or `decline` by server receipt order controls it. A decline
   creates no promise; an accept creates one promise owned by that responder. Later answers do not
   create additional promises.
4. The controlling `accept` must have `meta.in_reply_to` naming the typed review request and set
   `thread` to the request Act id.
5. A `resolve` on that thread closes the promise under the existing thread-close semantics and
   authority (any Member may resolve). No timer expires it, and no new Act or obligation table is
   introduced.
6. The server derives open promises from the request, its controlling accepted reply, and the
   absence of a `resolve` on that thread. It orders them by server receipt time, oldest first, and
   returns them only to their owner in `NextBrief.request_reviews`.
7. Each `request_reviews` item carries the request id, requester, original request context, artifact
   reference, and acceptance time. The field is additive and defaults to `[]`; because `client.next()`
   casts rather than parses the response, renderers also read it as `request_reviews ?? []` for older
   daemons. The CLI and MCP render this list separately from `owed_reviews` and `review_debt`.

The request's `meta.review` shape and `NextBrief.request_reviews` are shared protocol fields. Their
normative wire definition belongs in the single `SPEC.md` (Appendix A while unreleased), and any
schema change is gated by ADR 490 and the protocol feature epoch. The existing `nothing-vanishes`
lane 3 merge (#1897) brought the current epoch to 27; implementation must start from that base and
use the next epoch required by the protocol conventions.

## 5. Alternatives

- **Require a Lane for each review promise.** This uses the existing work-item lifecycle, but adds a
  Lane for short review work and entangles the request with a separate close and acceptance path.
- **Create a dedicated obligation record and lifecycle.** This is explicit, but duplicates facts
  already recorded in request, accept, and resolve Acts, adding synchronization and recovery rules.
- **Do not retain accepted promises.** This preserves the current behavior, where a request is
  discharged at acceptance and no `team_next` item remains; it does not meet the goal.

Deriving from accepted Acts keeps the message ledger as the source of truth and uses the existing
thread-close Act to end the obligation.

## 6. Limits and verification shape

The system records the accepted promise and whether its thread is closed; it cannot prove that a
review actually happened or represent a separate cancellation reason. An unresolved promise remains
on its owner's `team_next` until a Member closes the thread. The implementation should pin these
cases:

- accepted typed request appears for the accepting Member after its inbox loop is discharged;
- resolving the root request thread removes it;
- declined, unaccepted, and untyped requests do not create a row;
- an eligible set's first valid answer settles the request, yields at most one owner, and other
  Members do not inherit the promise;
- Lane acceptance remains represented only by `owed_reviews` / `review_debt`.

These are deterministic projection and boundary checks; no new database table, dependency, timer, or
experiment is required.
