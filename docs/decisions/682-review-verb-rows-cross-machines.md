# 682 — A review verb that decides nothing crosses the wire: the `lane.review_*` rows are stamped, pushed and folded

- Status: proposed
- Date: 2026-10-20
- Lane: `01M5D558Q4R9NNYB5TTEM2EYJJ` (goal `accountable-agents-positioning`; requested by dreamy,
  2026-10-20)
- Builds on: ADR 365 (the ledger kind — a best-effort verb crosses the wire and decides nothing when
  it lands), ADR 325 (`audit` is best-effort by contract, so it cannot be the replication log),
  ADR 131 (a row cannot bear correctness), ADR 202 (a verdict moves the lane it judges), ADR 667 (a
  verdict on an advisory ask is recorded and says it moved nothing), ADR 585 (the acceptor's
  independent claims), ADR 680 (the unbound verdict is named on the ack and in the audit), ADR 531
  (`origin_seq` is stamped at commit, not at insert)

## Context

The acceptance rail leaves records of what it decided. Two of them cross machines and five do not,
and nothing in the code says which is which.

`appendAudit` writes a row with `origin_seq 0`; the push selects only rows carrying a stamp, so an
unstamped row is never pushed and never folded — it exists on the machine that wrote it. Only rows
written through `appendReplicatedEvent` (the alias `appendLaneEventRequired`) are stamped. In
`packages/server/src/protocol/route.ts` the split is a fact about which call site a verb happens to
use: `lane.review_peer_confirmed` and `lane.review_human_asked` use the stamped writer and CROSS,
as does `lane.review_rerouted` (ADR 545's re-route, written through `appendLaneEventRequired`);
`lane.review_sent_back` (ADR 202's rejection record), `lane.review_acknowledged`,
`lane.review_advisory` (ADR 667), `lane.claims_verified` (ADR 585) and `lane.review_unbound`
(ADR 680) use `appendAudit` and do not.

**The evidence, from the acts of 2026-10-19.** big-body's 13:51 decline on lane `01M5ASVF3G` wrote
`lane.state_changed` — replicated, and present in the hub's db — and no `lane.review_sent_back`,
which is absent. stanley's 21:43 `wait` wrote `lane.review_unbound` on the node that handled it,
and the hub's copy of lane `01M4VKRXEX` has no such row.

**The same defect ADR 365 fixed, in a number the team already quotes.** ADR 365 made the wake
ledger cross because the number the team quoted for what its wakes cost was the number for ONE
daemon, and it got less true with every machine added. `deriveReviewMetrics`
(`packages/server/src/store/insights.ts`) counts `lane.ready_for_review` and `lane.closed` — both
stamped, both team-wide — beside `lane.review_sent_back` — unstamped, so per machine. The review
report therefore mixes a team count with a machine count, silently, and the mixed one is the
reviewer catch: how many lanes were sent back.

**How a row crosses, and the two ways a receiver can stop.** One allocator, one query, one rule
(ADR 365): the action decides the tag. A verb in `REPLICATED_LEDGER_VERBS` rides the `ledger` tag;
anything else is tagged by its prefix, so a `lane.*` verb rides the `lane` tag. The fold then has two
branches with different disciplines, and they fail differently:

- the **lane** branch requires the verb to be in `LANE_VERBS` (`packages/server/src/sync/fold.ts`),
  or it stops as `unknown_lane_event` — logged `sync_fold_unknown_event`, "a peer runs a newer
  build; upgrade this daemon — **retrying each tick**". It then projects the verb, and the default
  case projects nothing;
- the **ledger** branch refuses a `lane.*` or `presence.*` verb unless it is DECLARED in
  `REPLICATED_LEDGER_VERBS` (the guard that ADR 371 §4 added after `presence.session_ended` wedged
  every joiner at that row), logging `sync_fold_mistagged_ledger` — "terminal, **needs operator
  attention**".

The lane branch's whitelist already lists four of the five: `lane.review_sent_back`,
`lane.review_acknowledged`, `lane.review_advisory` and `lane.review_unbound`, under the comment
"Review verbs carry no state; they are held in `audit` for the readers that want them". For them
the fold could already name the verb; only the writer kept the row at home. `lane.claims_verified`
is not listed, because it never crossed and the whitelist was never needed for it.

**ryder found the loud version of the same shape.** Lane `01M5D62FZJ` hit the fold wedging on
replicated `lane.pulled` / `lane.pull_declined` / `lane.pull_released` verbs it could not name
(PR #3030, merged 2026-10-20): a stamped verb the fold cannot name stops the pull. The two lanes
touch the same file, and ryder's landed first.

## Problem

1. The acceptance rail's records are per-machine where they were written. A lane's history on
   another machine omits its rejection, its acknowledge, its advisory verdict, the acceptor's
   claims and its unbound verdict.
2. A count of those rows is a count of one machine's share, and one of the team's own reports
   already reads such a count beside team-wide ones without saying so.
3. The split has no rule behind it. Two verbs cross because their call site uses the stamped
   writer; five do not because theirs does not. A reader of the route cannot tell which is which,
   and moving either call site silently moves a row between machines — the kind of change no one
   notices until a teammate asks a question the record cannot answer.

## Decision

1. **The five review verbs cross**, as lane-kind rows: stamped, pushed and folded, so the row lands
   in every machine's audit and in the lane's history there.

2. **The writer is the only change.** A declared set — the lane verbs that must cross — is consulted
   by `appendAudit`, which stamps them through the existing stamped writer. The call sites in
   `route.ts` do not change, and `appendAudit` stays best-effort: a storage failure is a gap in the
   evidence, never a failed verdict (ADR 325 §4, ADR 131).

3. **The rows decide nothing when they land.** They are evidence, not state, and the fold's default
   projection changes nothing. Nothing decides on them across machines: `deriveReviewMetrics` reads
   one of them for a REPORT, and `pendingHumanReviews` reads `lane.review_peer_confirmed` — which
   already crosses — while joining the local lane row.

4. **`lane.claims_verified` joins the fold's whitelist.** It is evidence like its siblings (ADR
   585's acceptor's claims, written in the same guarded transaction as the verdict). The four
   others are already there.

5. **The skew window is named, and it is the small one.** Four of the five verbs are already in an
   older build's whitelist, so a new build pushing them stops no one. For `lane.claims_verified` an
   older build's fold does not know it and stops with `sync_fold_unknown_event` — "retrying each
   tick", not terminal — until that node refreshes onto a build that names it. The whitelist
   addition lands ahead of the writer change, and no row is lost: the pusher retries from its
   cursor. The ledger kind was rejected here: it would need the same declaration set, and an
   older build's fold would then stop on a mistagged `lane.*` verb with
   `sync_fold_mistagged_ledger`, which is terminal and asks for an operator.

6. **A count of these rows, read on the hub, is the TEAM count**; read on a node, it is that
   node's share plus what has folded there. The team's review metrics read the hub, so `sent_back`
   becomes team-wide with this change. ADR 680's rate stays the team count computed from the
   messages plus the replicated lane state — its watch says so, and its baseline predates this
   change.

7. **ADR 680's Decision 3 and 4 stand as amended on 2026-10-20**: the row is in the lane's history
   on every machine, and the ack is still what tells the sender. Nothing in ADR 680 promised the row
   would stay local.

## Consequences

- Every machine's audit grows by the review verbs — five rows per verdict. ADR 365 accepted the
  same growth for the wake ledger.
- **The team has no team-wide history of review verdicts from before this deploy.** Rows written
  by a build that predates it were never stamped, so they never left the node that wrote them. The
  history before the deploy date is a hole, and the rate measured from the messages (ADR 680's
  baseline) is the only team-wide number for that window.
- One line lands in the file ryder's #3030 touched: this branch rebases on that merge, and the
  whitelist is where the fold decides which verbs it can accept.
- The fold's whitelist stays load-bearing: a verb that crosses must be named there, or the receiver
  stops and says so. That is the shape ryder's lane found, and it is a gate, not a nuisance.
- `packages/server/src/store/audit.ts` cites "ADR 281" for the rule that observability never breaks
  a request path; ADR 281 is about workspace identity, and the rule lives in ADR 325 §4 and ADR
  131. This change corrects the pointer, because a comment that cites the wrong record teaches the
  next reader the wrong thing.

## Observability & Evaluation

**Traces.** No new span. The folded row's `origin_node` and `origin_seq` are the receipt: a row
that crossed carries the origin it was written on, and a row that did not carries none — the same
distinction ADR 365 made visible. Two log lines, both errors and both expected to be zero:
`sync_fold_unknown_event` (a replicated verb the fold cannot name — the wedge ryder's lane found,
and the window §5 names) and `lane_stamp_failed` (a review row that fell through to the unstamped
append — that machine's review history is local again).

**Eval.** The claim has two halves, and the second is what makes the first safe:

1. **The record is whole.** On a two-node team, a decline written on node A puts
   `lane.review_sent_back` in node B's audit and in node B's view of that lane's history. Baseline
   before this change, measured on the team's own db on 2026-10-19: of the review rows on the hub,
   every `lane.review_sent_back` was written on the hub and no `lane.review_unbound` existed off
   it; on the second node the same query returns nothing for either verb.
2. **No decision crossed with it.** The lanes' STATES are unchanged by the presence of folded
   review rows: the fold projects these verbs to nothing, so `lanes.state` on node B matches node A
   for every lane either way. A difference after this lands is the direct falsifier of the "decides
   nothing" claim, and means a review row changed a lane's state somewhere.

**Half 1 is not observed live.** This team runs one daemon today. Every number above comes from
one machine's db and from tests on two daemons in-process (`sync/`), not from two machines; the
honest first measurement is the first day a second one runs a review. Until then §1 is tested, not
witnessed.

**Experiment.** None. No flag and no rollout: the change is a writer, one declaration set and one
whitelist line, and on a single-machine install every row still lands exactly where it did before —
the only difference is that it now carries a stamp.
