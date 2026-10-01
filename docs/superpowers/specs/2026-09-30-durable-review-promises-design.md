# Durable review promises — design

- Date: 2026-09-30
- Author: big-body (lane `01M3TBW5QPKY76FTV9SAGM8MBZ`), in coordination with dolly
- Goal: `nothing-vanishes`
- Status: written design amendment for the service audit read is pending review; implementation plan awaits that review
- Decision record: [ADR 490](../../decisions/490-durable-review-promises.md) (accepted)
- Implementation plan: [durable review promises](../plans/2026-10-01-durable-review-promises.md) (awaiting review)

## 1. Outcome

When a Member accepts a directly addressed, typed `request_help` that asks for a review, the promise
remains visible in that Member's `team_next` brief, and the requester sees who accepted it and how
long it has been waiting. Both views derive from the request Acts and remain open until the request
thread is resolved. A missing projection field means the daemon predates this feature; it is not an
empty result. The weekly audit uses a Team-scoped read to identify accepted promises older than
seven days.

This closes the gap between a request being accepted and the review work being finished. An `accept`
currently discharges the request's open inbox loop, while no structured state remains for `team_next`
to display.

## 2. Boundaries

- Applies only to an explicitly typed review request. Generic help requests keep their existing
  accept/decline lifecycle.
- A typed review request addresses one Member directly. Team targets and eligible sets are out of
  scope for this increment; a single recipient keeps ownership and decline semantics unambiguous.
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

1. A review `request_help` carries a typed `meta.review` reference and is a root Act with no existing
   `thread`, so resolving it closes only this review request. Its body remains the human-readable
   context. The reference is a discriminated union: `{kind:'pr', repo, number}` where `repo` is a
   GitHub `owner/name` slug and `number` is a positive integer; `{kind:'commit', repo, sha, path?}`
   with the same `repo`, a full 40- or 64-digit hexadecimal `sha`, and an optional repository-relative
   path without `.` or `..` segments; `{kind:'lane', id}` with an existing Lane ULID; or
   `{kind:'url', url}`. A URL is absolute HTTPS and rejects userinfo, query strings and fragments.
   Artifact refs contain no credentials or signed access tokens. Parse this metadata through the
   shared protocol schema at each external boundary.
   Other `request_help` Acts are unchanged; old, untyped requests are not inferred to be reviews from
   their body.
2. A typed review request addresses exactly one Member. Team targets and `meta.eligible` are not
   accepted for this form. Only that recipient's `accept` with `meta.in_reply_to` naming the request
   Act creates a promise; the named recipient is the owner. A direct recipient's `decline` creates no
   promise. Repeated accepts from that recipient derive one row, selected deterministically by the
   minimum `(ts, id)` pair; `accepted_at` is that Act's origin timestamp. The owner is fixed by the
   root request's direct target, so this projection needs no cross-daemon owner arbitration. `ts` is
   the sender's clock, not receipt time, and the seven-day audit inherits any sender clock skew.
3. A controlling `accept` sets `thread` to the request Act id. A `resolve` on that root thread
   closes the promise under existing semantics; any Member may resolve, and the requester may use it
   to withdraw the request. For this typed request, the closing `resolve` is Team-addressed so both
   requester and owner receive it. If someone other than the owner resolves it,
   `NextBrief.review_closures` gives the owner one notice, including the closer, until the owner's
   inbox cursor has crossed that `resolve` Act. The requester sees the same `resolve` Act in the
   request thread. No timer expires a promise, and no new Act or obligation table is introduced.
4. The server derives each open promise from the typed request, its accepted reply, and the absence
   of a `resolve` on that thread. It returns an owner-side `NextBrief.request_reviews` row to the
   accepting Member and a requester-side `NextBrief.requested_reviews` row to the requester. Both
   lists include every matching open promise, oldest `accepted_at` first, with request id as the
   stable tie-breaker. The second row says who accepted and when, so the requester can chase a quiet
   owner or withdraw.
5. Both per-Member open-row types carry request id, requester, owner, original request context,
   artifact reference, and `accepted_at`. The closure notice carries request id, resolve Act id,
   closer, and resolve timestamp.
6. The protocol schema keeps these three fields optional and without defaults so a new client can
   parse an older daemon's response without inventing a value. A daemon that supports the feature
   MUST emit all three arrays, including `[]` when it has observed no matching rows. An omitted field
   means "this daemon does not report this projection," while a present empty array means "this
   daemon reports none." CLI/MCP renderers preserve that distinction by showing the section as
   unsupported when its field is absent and as empty only when it is `[]`. The CLI and MCP render
   these lists separately from
   `owed_reviews` and `review_debt`. When a thread closes, open rows disappear; the `resolve` Act
   remains in that request's thread as the closure receipt.
7. The scheduled weekly audit runs as the `sweep` service Member, so its per-caller
   `NextBrief.requested_reviews` cannot provide the Team-wide population. Add
   `GET /teams/:slug/review-promises?open=1`, authenticated as an active Member of the named Team.
   It returns every open promise in that Team, oldest `accepted_at` first and request id as the
   stable tie-breaker, with only `{request_id, requester, owner, accepted_at}` per row. It omits
   request prose and artifact references. The audit uses this read to flag promises older than
   seven days. A supported response always includes `review_promises`, including `[]`; an older
   daemon that does not serve the route is unsupported, so the audit abstains instead of reporting
   a clean empty population.

The request's `meta.review` shape, `NextBrief.request_reviews`, `requested_reviews`, and
`review_closures`, plus the `review_promises` response, are shared protocol fields. Their
normative wire definition belongs in the single `SPEC.md` (Appendix A while unreleased), and any
schema change is gated by ADR 490 and the protocol feature epoch. The existing `nothing-vanishes`
lane 3 merge (#1897) brought the current epoch to 27; implementation must start from that base and
use the next epoch required by the protocol conventions.

## 5. Alternatives

- **Require a Lane for each review promise.** This uses the existing work-item lifecycle, but adds a
  Lane for short review work and entangles the request with a separate close and acceptance path.
- **Create a dedicated obligation record and lifecycle.** This is explicit, but duplicates facts
  already recorded in request, accept, and resolve Acts, adding synchronization and recovery rules.
- **Use only the per-Member `NextBrief` rows for the weekly audit.** The scheduled `sweep` Member
  cannot see requesters' per-Member rows, so this would make the audit falsely report an empty
  population.
- **Do not retain accepted promises.** This preserves the current behavior, where a request is
  discharged at acceptance and no `team_next` item remains; it does not meet the goal.

Deriving from accepted Acts keeps the message ledger as the source of truth and uses the existing
thread-close Act to end the obligation.

## 6. Limits and verification shape

The system records the accepted promise and whether its thread is closed; it cannot prove that a
review actually happened or represent a separate cancellation reason. An unresolved promise remains
on its owner's and requester's `team_next` until a Member closes the thread. The implementation
inherits the freshness of that daemon's replicated Act ledger; it does not add a cross-daemon
read-after-write barrier. The implementation should pin these cases:

- accepted typed request appears for the accepting Member after its inbox loop is discharged;
- the requester sees the accepted owner and age, and the Team-wide read lets lane 5's sweep identify
  open requests older than seven days;
- resolving the root request thread removes it;
- declined, unaccepted, and untyped requests do not create a row;
- only the directly named Member can create the promise; a Team or eligible-set typed request is
  rejected;
- duplicate accepts from the direct recipient produce one row with the same selected Act and owner on
  every synchronized machine;
- the requester sees the accepted owner and age, then both open rows disappear when the thread is
  resolved;
- a Team-addressed non-owner resolution creates one owner-side notice, with the closer, until the
  owner's inbox cursor crosses that `resolve` Act;
- a supported daemon emits empty arrays when there are no rows; a response from an older daemon omits
  the fields, and CLI/MCP renderers report unsupported data rather than treating absence as zero;
- an authenticated Member of the named Team can read the minimal Team-wide audit rows, while an
  unauthenticated or cross-Team caller is refused by the existing auth boundary;
- the audit abstains when the Team-wide route is unsupported and reports an empty population only
  when a supported daemon returns `review_promises: []`;
- Lane acceptance remains represented only by `owed_reviews` / `review_debt`.

These are deterministic projection and boundary checks; no new database table, dependency, timer, or
experiment is required.
