# 628 — Dispatch checks the owner is on it

- Status: accepted
- Date: 2026-10-16
- Lane: `01M51G15WVPHNN9JB4AVGTXP7E`
- Amends: nothing — the dispatch gate gains a branch; ADR 179/199/306 stand

## Context

On 2026-10-16 the board dispatched duplicate ghost workers onto owned, live lanes twice in one
night: lane `01M50C7QB8` at 02:52 UTC and lane `01M50ZJ8KG` at 04:00 UTC (`sender: board`,
`edge: dispatch_continuation`). Both leases minted because the owner's presence had gone stale —
long CI waits with no tool calls, no heartbeat — while the owner was mid-flow (acts minutes old
in the first case, tool calls seconds apart in the second). The second worker's output was
correct both times; one whole lane-3 implementation was still thrown away, re-derived
independently by the owner who never knew a continuation had been dispatched.

The pass-level guard (`deriveSeatPasses` skipping live presence) is heartbeat-based, and a
heartbeat goes quiet during exactly the gaps active work contains — waiting on CI, reading,
thinking. Presence answers "is a socket open", not "is someone on it".

## Problem

`dueDispatchContinuationWorkOrders` emits a candidate for every claimed/active lane of a seat
that reads offline, and nothing asks whether the owner is engaged. The duplicate is the defect;
the silence is what made it wasteful rather than merely redundant.

## Decision

1. **Engagement is live presence OR recent activity inside W.** `ownerEngaged(db, teamId,
   member, now)`: `hasLivePresence` (the existing heartbeat read), or any act / audit action by
   the seat within the last W (`lastActionBySubject` plus `messages.from_member`, presence noise
   excluded as elsewhere). **W is 15 minutes** — longer than any CI wait or coffee gap in the
   night's logs, shorter than any real stall.
2. **An engaged owner is never double-worked.** At the point a `dispatch_continuation` candidate
   would otherwise take the slot, an engaged owner suppresses it instead: no lease, an audit row
   `residency.dispatch_suppressed` carrying the evidence (last act id + age), and — at most once
   per W per lane — a directed `request_help` nudge: *"the board held a continuation wake for
   lane X (you look active) — take it up or release it."* The cooldown is read from prior
   suppression rows, so no new state.
3. **The nudge is voiced like the incident notices** (never self-send): lane.created_by when that
   is not the owner, else the most recent non-owner lane actor, else suppress-only with the audit
   noting no voice. An engaged self-opener still gets full duplicate protection; `team_next`
   still shows them the need.
   _(Amended 2026-10-17: superseded by [ADR 646](646-dispatch-nudge-board-voice.md): the nudge comes from a
   `board` service seat, and a self-opener is nudged too.)_
4. **Silence dispatches.** Engagement fades with inactivity, so a nudged owner who stays quiet
   ages out within W and the next poll dispatches normally. The loop's liveness guarantee is a
   delay of at most one window, never a refusal. Unowned and idle-owner lanes dispatch exactly as
   today.

## Consequences

- The demonstrated collision cannot recur: both night cases read engaged under this rule.
- A new audit action `residency.dispatch_suppressed` (subject `none` — machine decision, like
   the surrounding residency rows) makes restraint measurable: suppressed-then-resumed (owner
   picked it up) vs suppressed-then-stalled (human intervened anyway). If the second grows, W is
   wrong or nudges don't ring, and the rows say which.
- One extra presence read + two activity reads per continuation candidate that survives the
   existing cap/still-true/moved gates — the check runs only where a lease would otherwise mint.
- The nudge sender is whoever the lane's record names, daemon-composed and marked
   (`meta.dispatch_nudge`); like the incident notices it is advisory and best-effort — a failed
   send never blocks the suppression.
- _2026-10-17 (lane 01M55WS37R):_ the nudge is minted by whichever daemon served the poll and
   stamped with that node, and the hub refuses a push as a seat bound to another node
   (`bound_elsewhere`), which wedged a joiner's whole sync. The voice is now the first of the lane
   creator, then recent non-owner actors, that is unbound or bound to the serving node; none
   eligible reads as `no_voice`, and suppression still holds.

- _2026-10-17 (ADR 646):_ the suppression row is written once per episode (the first suppression
  of a lane inside W), not on every poll. The tuning rule above compares episodes, so it reads the
  same rows it always meant to.

## Observability & Evaluation

- **Eval:** `dispatch_suppressed` rows with evidence; the wiki claim's falsifier inverts — after
   any engaged-owner night, no second presence attaches to the lane within W of the owner's last
   act. Pre-registered tuning: if suppressed-then-stalled exceeds suppressed-then-resumed over
   two weeks, W shortens or the nudge voice changes — the rows carry both halves.
- **Traces:** the new audit row only; the nudge is an ordinary directed act in the log.
- **Experiment:** n/a — falsifiable from the audit table after one engaged night.
