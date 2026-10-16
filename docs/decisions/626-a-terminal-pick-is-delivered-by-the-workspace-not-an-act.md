# 626 — A terminal pick reaches its seat through the workspace, not through an act

- Status: accepted
- Date: 2026-10-16
- Deciders: nick, in chat on 2026-10-16, choosing option B of three
- Lane: `01M5162MTCDYFFDZ6J0JQTTSDJ`
- Amends: ADR 624 Decision 3. This ADR replaces that decision's delivery mechanism. ADR 624's other
  decisions stand.

## Context

ADR 624 Decision 3 says that when a claim carries `pick` and changes the lane's owner, the daemon
delivers a directed interrupt-class act to the new owner. Its purpose is to make sure a seat hears a
terminal pick on every harness. In Claude Code, the output of a `!` command lands in the agent's
context. In a split pane on another harness, nothing tells the agent.

Decision 3 left one open point to lane 2: who sends that act, the seat itself or a system sender.

## Problem

Lane 2 found that neither sender works.

- **The seat itself.** A terminal pick is the seat claiming the lane for itself. An act from a
  seat to itself never arrives, because every read path drops a seat's own acts with a
  `from_member != ?` filter. The paths are:
  - the inbox (`store/messages.ts`, three queries);
  - delivery (`store/delivery.ts`);
  - the interrupt candidates (`store/interruptCandidates.ts`, two queries);
  - the wake scan (`store/residency.ts`).

  `route.ts` says it directly: "a self-send never reaches an inbox". Making the pick act an
  exception would mean editing about eight queries, and every future query would have to remember
  the exception too.
- **A system sender.** `messages.from_member` is a foreign key to `members`. The daemon has no member
  of its own (`SYSTEM_CLOSER` in `laneSweep.ts` is a name on an audit row, not a member), so a
  system-sent act needs a new roster identity on every team.
- **The human named in the pick.** Sending the act from `requested_by` would put an act in the human's
  name that the human never sent. That is the false attestation ADR 624's honest-label rule exists
  to prevent.

## Decision

1. **The daemon does not deliver an act for a terminal pick.** It records the pick on
   `lane.claimed` (ADR 624 Decision 1) and enforces the honest-label rule (ADR 624 Decision 2). It
   sends nothing else.
2. **The workspace delivers the pick.** `musterd pick` runs in the seat's own workspace and writes a
   pending-pick marker into that workspace's `.musterd/` directory (lane `01M5162QS1`). The marker
   holds `{lane, title, requested_by, at}`. The seat's interrupt check (`musterd inbox
   --interrupt-check`, which every harness's hook runs in the same folder, ADR 088) shows the
   marker once and then deletes it. The text is the pick act's text: "nick picked this lane for you
   in the lane picker (terminal, unattested): "<title>". Reply with a 3–5 line plan, then start
   unless redirected."
3. **A /live pick is unchanged.** It is a handoff from the signed-in human. The handoff act is
   already directed and can wake the seat, so it is delivered as every handoff is.

### Rejected

- **The seat as sender, with a `lane_pick` exception in each filter.** It works, but the exception
  has to live in about eight queries, and every new read path has to copy it.
- **A system member on every team.** It is the cleanest model, but it needs roster and schema work
  well beyond the lane picker, for one notice.
- **Sending as `requested_by`.** It is a false attestation (see Problem).

## Consequences

- A terminal pick reaches the seat at its next hook boundary: the Stop hook, the tool-boundary
  check, or its next prompt. It does not reach the seat when the seat is idle at its prompt,
  because the idle doorbell (ADR 558) is driven by the daemon and the daemon sends nothing here.
  The human who picked is at that terminal, so this gap is a nudge away. In Claude Code, the `!`
  output is in the agent's context already.
- The marker is local to the workspace. A seat whose session runs on another machine than the
  picker's terminal does not see it. The lane picker only picks for the seat whose workspace it
  runs in (spec §4.2), so this does not arise in v1.
- The daemon's patch policy gains `decidePickPatch` (`sync/claim.ts`), shared by the local path
  and the hub's arbitration:
  - `pick` rides only a patch that sets `owner_seat`;
  - `attested: true` is accepted only from the human it names;
  - `release_reason` rides only a release.

## Observability & Evaluation

- **Traces:** `lane.claimed` rows carrying `pick` (ADR 624) are the record of every pick. A shown
  marker leaves no daemon row by design, because the workspace delivers it.
- **Eval:** ADR 624 measures the time from a pick to the seat's first act on the lane. If that is
  measured separately for `via: 'terminal'`, it tests this decision. A terminal pick that sits past
  one interrupt-check interval, on a harness whose hook runs, means the marker was not shown.
- **Experiment:** n/a. There is one mechanism, so there is no arm to compare against.
