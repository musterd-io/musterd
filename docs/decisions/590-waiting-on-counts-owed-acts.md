# 590 — The waiting-on view counts only acts that are owed an answer, closed by the ADR 434 predicate

- Status: accepted (2026-10-13, nick, in chat: "yes")
- Date: 2026-10-13
- Deciders: nick, wallow
- Lane: `01M4VZ5Y31KMTQPA3X0EXSF0WA`
- Amends: [ADR 050](050-insights-report-metrics-waiting-on.md), the waiting-on view's definition
  only. Its purpose (name who the bottleneck is, oldest first, threads not messages) stands.

## Context

ADR 050 defines the waiting-on view as `openActionNeeded` (ADR 024/046) aggregated by recipient:
every act addressed to one member except a `resolve`, open until a `resolve` lands on its thread.
`waitingOn` (`store/insights.ts`) feeds the `waiting_on` section of `GET /report` and the morning
digest's waiting list (ADR 502).

`openActionNeeded` is a per-viewer inbox filter, and the client has the viewer's answered and
discharged ids to subtract. Applied server-side to the whole log, `waitingOn` had neither. Measured
on a copy of the revive hub, 2026-10-13: 7,730 open threads across 27 members (izzo 952, stanley
902, miley 836), the oldest from 103 days ago. Every `accept`, `status_update` and `message` anyone
was sent counted as something they owed, and so did every ask they had answered without a
`resolve`. It was also the report's second-largest cold read: every member-directed message the
team ever sent, folded in JS (150–200 ms cold).

ADR 434 named one predicate for "is this act still owed?" (`discharge.ts`), and the inbox, the
open-loops gauge, the open directed ledger and the per-recipient ledger all use it. `waitingOn` was a
fifth reader that never moved to it.

## Decision

1. An act is owed when it is addressed to one member and is an `ask`, `request_help`, `handoff`,
   `steer` or `challenge`, or carries `meta.urgent`. Every other act is information, not an
   obligation.
2. An owed act is discharged by `undischargedSql` (ADR 434): an `accept`/`decline` naming it, a
   `resolve` on its thread, or the recipient's own act naming it or later in its thread. A
   `handoff` is also discharged when the lane its `meta.lane_handoff.lane` names is submitted for
   acceptance or terminal (the ledger's `laneHandoffDischarged` rule).
3. The view still counts distinct threads per recipient, aged from the thread's oldest open owed
   act, sorted oldest first. `clock` and `since` keep their meaning.
4. The filtering runs in SQL, grouped by recipient and thread.

## Consequences

- Prototype on the same copy: nick 112 open threads, everyone else 45 or fewer. The numbers name
  real queues again.
- A thread opened by a plain `message` no longer counts unless the sender flagged it urgent. A
  sender who needs an answer says so with an owed act.
- A `steer` counts until the recipient answers it or its thread is resolved. A seat that acts on a
  steer without replying still shows it as owed; the reply is the record that it was taken.
- A handoff whose lane is named only in prose (no `meta.lane_handoff`) is not discharged by the
  lane rule, the same as in the ledger.
- The digest test that asserted the old behaviour (an answered ask still owed, and an `accept`
  owed by its recipient) now asserts the new one.

## Observability & Evaluation

- **Traces:** `waiting_on` in `GET /report` and `waiting` in the digest. No new rows.
- **Eval:** `insights.test.ts` covers an informational act (not owed), an urgent one (owed), a
  recipient reply (discharged), and a handoff whose lane is done (discharged). `digest.test.ts` and
  the `/report` integration test hold the shape.
- **Experiment:** n/a. The falsifier on the live team: a member listed in `waiting_on` whose oldest
  open thread was answered by them, accepted or declined by anyone, or resolved.
