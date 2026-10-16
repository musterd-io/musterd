# 624 — The lane picker: a pick is recorded with how strongly "who asked" is proven

- Status: accepted
- Date: 2026-10-16
- Deciders: nick, in chat on 2026-10-16, while designing `musterd pick`
- Lane: `01M5162FVMTMQYBS3WJPBEN4B3`
- Spec: `docs/superpowers/specs/2026-10-16-musterd-pick-design.md`
- Builds on:
  - ADR 442: a command run in a seat's workspace acts as that seat, and `--as` is gone;
  - ADR 083 and ADR 203: claim and handoff;
  - ADR 088 and ADR 558: the interrupt line;
  - ADR 534: the board's 14-day history window;
  - ADR 582: find-work.
- Protocol change: yes (hard rule 1). It adds three optional fields: `pick` and `release_reason`
  on the lane patch, and `declined` on the lane.

## Context

When nick asks a seat what it could work on, the seat reads the board and answers with a
selection. On 2026-10-15, izzo turned 106 open lanes into six "fit my role" picks, three times.
The selection is the seat's judgement, and it was presented as the board.

`musterd pick` (the spec) replaces that answer with a list that musterd renders. A human opens it in
two ways:

- the seat runs `musterd pick --open`, which opens the /live lane picker in the human's browser;
- the human runs `musterd pick` in the seat's terminal (`!` in Claude Code, or a split pane on any
  other harness).

Either way, the human picks a lane and it goes to the seat they are talking to.

## Problem

1. **A terminal pick cannot be signed by the human.** The CLI in a seat's workspace acts as that
   seat (ADR 442). If the record said "nick asked", it would claim something that nothing proves.
   If it said nothing, the provenance that the accountability positioning is built on would be
   lost.
2. **A seat does not hear its own claim.** A terminal pick is the seat claiming the lane, so no act
   reaches the seat. In Claude Code, the `!` output lands in the agent's context. In a split pane
   on another harness, nothing does.
3. **A decline leaves no trace the next picker can show.** `lane_release` takes only an id. A seat
   that declines a picked lane cannot say why, so the human can pick the same lane again without
   knowing.
4. **Three front ends would compute "open" three ways.** The terminal, the plain table, and /live
   each need the same list, including the same answer to "is this lane blocked".

## Decision

1. **`pick` on the lane patch.** The patch takes an optional `pick: {via: 'terminal' | 'live',
   requested_by, attested, harness?, at}`. It is meaningful only on a patch that sets
   `owner_seat`. The daemon records it verbatim on the `lane.claimed` audit row.
2. **The honest-label rule.** `attested: true` is allowed only when the patch's actor is
   `requested_by`. That happens with a /live handoff, where the signed-in human hands the lane to
   the seat. When a seat claims a lane for itself, the pick is `attested: false`, and the daemon
   refuses a self-claim that says `true`. A terminal pick is therefore never recorded as proven.
   The record says the seat claimed the lane at the human's request, and that the request is
   unverified.
3. **A picked claim raises a directed interrupt-class act to the seat.** When a claim carrying
   `pick` changes the lane's owner, the daemon delivers a directed act to the new owner. The act
   carries `meta.lane_pick {lane, title, requested_by, via}`, and its body asks the seat for a short
   plan. It uses the interrupt line, so each harness's existing hook delivers it. Re-picking a lane
   the seat already owns raises nothing. The sender (the seat itself, or the daemon's system
   sender) is lane 2's choice, made against what `routeEnvelope` allows. A /live pick needs no new
   act, because the handoff is already directed and can wake the seat.
4. **`release_reason` and `declined`.** A patch that releases a lane to `open` may carry
   `release_reason` (1 to 500 characters). The lane then holds `declined: {by, reason, at}`, and the
   `lane.released` row carries `reason`. Any later claim clears `declined`, so the note never sits on
   a lane that someone owns. `release_reason` on a patch that is not a release is a 400.
5. **`pickerRows` is the one list.** `pickerRows(board, seat, now)` in `@musterd/protocol`
   (`picker.ts`) turns `GET /lanes` into groups:
   - only open, unowned lanes, so parked lanes never appear;
   - grouped by goal in alphabetical order, with lanes that have no goal last;
   - oldest first within a group;
   - split into claimable and blocked.

   **Blocked comes only from the board's `unmet_dependency` warnings.** The daemon already
   decided what a met dependency is: a dependency that the board omits because of ADR 534's window
   counts as met. Deciding again from `depends_on` would disagree with the daemon for every lane
   whose dependency closed more than 14 days ago. `filterPicker(view, text)` is the shared
   filter: every word must match the id, title, goal, or areas. It drops empty groups.

### Rejected

- **Signing a terminal pick as the human.** The human's credential would have to be reachable from
  the seat's workspace. That reverses ADR 442, and any agent in that folder could then act as
  the human.
- **Confirming every terminal pick in /live.** The pick would be verified, but every pick would
  cost a browser round trip. This is deferred as a `--verify` flag, to add if the unverified label
  proves to be a problem.
  Follows-up: none — a `--verify` lane opens only if the Eval's decline or latency readings show the label misleads (2026-11-30)
- **Reading blocked from `depends_on`.** See Decision 5.
- **Reading the decline note from lane history.** The picker would make one `GET /lanes/:id` call
  per row. A field on the lane costs nothing to read.

## Consequences

- An unverified pick is recorded as unverified, and a /live pick is recorded as verified. A
  reader of `lane.claimed` can tell the two apart without guessing.
- The protocol gains three optional fields. An older daemon ignores `pick` and `release_reason`
  (zod strips unknown keys) and never sends `declined`, so mixed builds degrade to today's
  behaviour.
- Lanes 2–5 build on these names (`docs/superpowers/plans/2026-10-16-musterd-pick.md`).

- **2026-10-16 — `pickerRows` is also exported from `@musterd/protocol/wire`** (lane `01M5162T6H`, the
  /live lane picker, #2733). The browser needs it, and the root index carries node-only modules
  (`guidance-epoch` imports `node:fs`); the overlay, as the page's first runtime import of the root,
  broke `/live` in dev. `picker.ts` has only type imports, so `wire.ts` re-exports it unchanged. No
  schema or behaviour change: the same function, reachable from the browser-safe entry point.

## Observability & Evaluation

- **Traces:**
  - `lane.claimed` rows that carry `pick`, split by `via` and `attested`;
  - `lane.released` rows that carry `reason`;
  - the `meta.lane_pick` act.
- **Eval**, over the first 30 picks after lane 3 ships:
  1. **Picks per day by `via`.** This shows whether the terminal or /live is the path people use.
  2. **Declines over picks.** A falsifier: if most picks are declined, the list does not show what
     a seat can do, and `pickerRows` needs a fit signal.
  3. **Time from a pick to the seat's first act on the lane.** This tests whether Decision 3's
     notice is heard on every harness. A `via: 'terminal'` pick on a non-Claude harness that sits
     past the interrupt window means the notice did not land.
- **Experiment:** n/a. The eval above is the measurement, and there is no alternative arm to
  compare against.
