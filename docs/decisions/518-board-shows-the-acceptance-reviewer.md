# 518 — The lane board says who an awaiting-acceptance lane waits on

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (asked for it as a user on 2026-10-05; told miley to start), miley (owns the board)
- Lane: `01M46XEJ7XAWVGXXJ2960EBW4T` (board readability, increment 1 (b))
- Relates to: ADR 169/283 (`verified` / `close_reason`, the projection pattern this copies), ADR 192
  and 202 (acceptance and the `lane_review` ask), ADR 234 (acceptance-exempt), ADR 303 (the ready
  row records the routing evidence)

## Context

On 2026-10-05 nick spent about 20 minutes asking a seat questions the web board should answer. One
of them was: for every lane awaiting acceptance, WHO is it waiting on? The board could not say.
The answer existed in two places only:

- the `lane.ready_for_review` audit row, whose `review_selection` records the picked reviewer and
  the routing outcome (`peer_selected`, `human_fallback`, `wake_queued`, `no_candidate`,
  `acceptance_exempt`);
- the open `lane_review` ask itself, which is the more current of the two, because a re-route or a
  tiebreak supersedes the ready row's pick (`openAcceptanceAsk`, review.ts).

The seat answered by reading the daemon's SQLite file by hand. Example from that morning: izzo's
#2080 was waiting on ghost, and nothing on the board or in `team_next` said so.

## Problem

`GET /lanes` returns `LaneSchema` rows and nothing about review routing. A client cannot derive
the reviewer, because neither the ask nor the audit row reaches it. Adding a field to the lane
board's response changes `@musterd/protocol`, which AGENTS.md hard rule 1 gates on an ADR.

## Decision

1. **Two optional, never-stored projection fields on `LaneSchema`**, the same kind as `verified`
   and `close_reason`:
   - `acceptance_reviewer: string` — the seat that holds the lane's open `lane_review` ask: newest,
     unanswered (no accept/decline in reply), unresolved, and not superseded by a re-route.
   - `acceptance_route: AcceptanceRoute` — the routing outcome the ready row recorded:
     `peer_selected | human_fallback | wake_queued | no_candidate | acceptance_exempt`. Read from
     `review_selection.outcome`, falling back to the older flat fields (`no_candidate: true`,
     `acceptance_exempt: true`, `wake_queued: true`, `reviewer`) on rows written before ADR 303.
2. **`GET /lanes` sets them on lanes in `awaiting_acceptance` or legacy `ready_for_review` only**,
   from one batched read (three single-pass scans, the `openAcceptanceLoad` shape, not a per-lane
   correlated query). Every other lane carries neither.
3. **Absent means unknown**, as for `verified`: an older daemon, a lane whose ready row predates
   the field, or an outcome this build does not recognise (parsed, never cast). A reader never
   fills the absent case with a default.
4. **The board renders the wait, not the routing.** A reviewer reads "waiting on <seat>"; no
   reviewer with `no_candidate` reads "no eligible reviewer"; `acceptance_exempt` reads
   "acceptance-exempt"; `wake_queued` without an open ask reads "waking a reviewer". Anything else
   says nothing.

## Consequences

- nick's question 3 (for every blocked or awaiting lane, WHAT or WHO it waits on) is answered on
  the board. The blocked half shipped in #2102 without an ADR: it reads `depends_on`, already on
  the wire.
- `acceptance_reviewer` comes from the ask, not the ready row, so a re-route shows the new seat
  rather than the one the picker first chose. The two disagree by design. Diversity claims still
  read the close row (ADR 188), never this field.
- The CLI and `team_next` do not show these fields yet. They are wire-visible, so either can adopt
  them without another protocol change.
- Cost: three extra scans per `GET /lanes`. They are bounded the same way `openAcceptanceLoad` is
  and run only when at least one lane is awaiting acceptance.

## Observability & Evaluation

- **Traces:** none new. The fields are read-only projections of rows that are already recorded:
  the open `lane_review` ask, `lane.review_rerouted`, and `lane.ready_for_review`.
- **Eval:** does a human reading the board agree with the audit about who is waiting? Dataset: the
  awaiting-acceptance lanes on revive at any moment. Baseline: stanley's hand queries of
  2026-10-05, run against the daemon's SQLite file. Check: for each awaiting lane,
  `acceptance_reviewer` equals the holder found by `openAcceptanceAsk`. The integration test
  asserts this for the routed case; the unit tests cover re-route and supersession.
- **Experiment:** n/a. This is a display of existing state, not a behaviour change for agents.
