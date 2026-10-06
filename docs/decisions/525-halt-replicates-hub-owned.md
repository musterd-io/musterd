# 525 — Halt replicates: the hub owns the standing, every node enforces it

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (approved taking the lane, 2026-10-05); the authority rule is ADR 501's, unchanged
- Lane: `01M46VYZ84DWBYDAC2ABDYWEMD` (goal `security`)
- Builds on: ADR 501 (halt as revocation), ADR 367 / 398 (hub-owned, replicated policy — the
  pattern), ADR 516 (holds, the same pattern a day earlier), ADR 325 §Offline semantics (an act that
  may not fork refuses while the hub is unreachable)
- Protocol change: yes (hard rule 1) — `SyncHaltRequest`; `seat.halted` / `seat.resumed` become
  replicated events on the `policy` sync kind

## Context

ADR 501 made halt a standing on the member row (`halted_at`, `halted_by`, `halted_reason`) and put
every refusal behind it: `memberStandingRefusal`, the claim handshake, the gate, residency. But the
route wrote the standing only on the daemon that took the request. None of the three columns rode a
sync kind, and `seat.halted` was a plain audit row. Found while surveying for ADR 516 and confirmed
by test: a seat halted on the hub kept calling, claiming and being woken against a joiner.

## Problem

A halt that stops a seat on one machine and leaves it free on another is not a stop. The human
believes the seat is halted; the seat, working through the other machine, is not.

## Decision

1. **The hub owns the halt standing.** Halt and resume are decided once, on the hub, and stamped as
   replicated `seat.halted` / `seat.resumed` events carrying `{at, reason?, sponsor_scoped}` plus
   the deciding node's counts. They ride the `policy` sync kind — the kind for hub-minted Team
   rules, already refused from any node but the hub's own loopback — so no joiner can mint one.
2. **A joiner forwards.** `POST /members/:name/halt|resume` on an enrolled joiner forwards to the
   hub's `/sync/halt` (node-authenticated, actor resident, then re-authorized on the HUB's roster by
   ADR 501's rule: a human in good standing who is an admin or the agent's sponsor, against an agent
   target). An unreachable hub answers `hub_unreachable` and nothing is halted locally — a halt is
   not an act that may fork. The joiner then pulls, so its own refusals start at once, and routes
   the `steer` to the seat as today.
3. **Every node applies the same local effects** (`packages/server/src/store/halt.ts`): set the
   standing with the hub's `at`, revoke the seat's session leases, end its presence rows, expire
   any unspawned wake lease. The hub does this when it decides; a joiner does it when it folds.
   Folding a halt for a seat the node does not have is a no-op, never a fold stop.
4. **Live sockets are closed where they are.** The deciding node evicts its own; a folding node
   evicts after the fold (the fold runs in a transaction with no connection hub), with the same
   `halted by <human>: <reason>` sentence.

## Consequences

- "A halt on either machine refuses the seat on both" holds: pinned by `sync/halt.test.ts`, which
  fails on the pre-ADR-525 fold.
- A joiner whose hub is down cannot halt. That is deliberate (Decision 2), and it is the case where
  the human should reach the hub's machine or wait — a local-only halt is the bug this closes.
- Between the hub's decision and a joiner's next pull tick the seat can still act on that joiner.
  The window is the pull interval; a halt issued ON the joiner closes it immediately by pulling.
- ADR 501's single-daemon behaviour is unchanged: a daemon with no hub decides locally and stamps
  the same event, which simply has no reader until a joiner enrolls.

## Observability & Evaluation

- **Traces:** `seat.halted` / `seat.resumed` are now replicated audit rows, present on every node
  with the hub's origin stamp; `agent_session_lease.revoked` (`cause: 'halt'`) and
  `presence.session_ended` (`cause: 'halt'`) are written by whichever node applied the effects.
- **Eval:** after a halt, count calls the halted seat makes that are NOT refused, per node.
  Baseline: unbounded on a joiner before this ADR. Target: zero after the joiner's next pull.
- **Experiment:** on the live pair, halt a test seat from the hub and confirm a call from the
  joiner is refused with the halt sentence within one pull interval.
