# 766 — A presence detach is exempt from residence

- Status: accepted
- Date: 2026-10-29

## Context

On 2026-10-29 ryder moved from macbook-air-2 to the new Linux joiner `musterd-joiner-1`
(lane `01M64AYDSZ`, via ADRs 762 and 765). The move bound ryder to the new node. The Air still
held a local presence row for ryder, and it closed that row: it staged a `presence.detached`
with ryder as the actor. The hub's ingest refused it (`403 bound_elsewhere`; `refused_json` on
the Air read `{"seat":"ryder","kind":"presence","bound_to":"musterd-joiner-1"}`). A refusal rolls
back the whole batch, so everything the Air's remaining seats did stopped reaching the hub
([joiner wedges](../wiki/joiner-wedges.md)). The only remedy was an admin
`musterd node unbind ryder`, which the wiki records as racy.

## Problem

Residence at ingest (ADR 355 §5, ADR 360) asks whether this node may speak **as** this seat. A
detach does not speak as the seat anywhere else. The fold applies it as
`DELETE FROM presence WHERE id = ? AND node = <origin>`, so it can only close the pushing node's
own replicated row. Refusing it protects nothing, and it wedges every joiner that a seat moves
away from while that seat had a session there. The remaining Air 2 moves (dreamy, lazara, mason,
resident) would each hit it.

## Decision

1. A `kind: 'presence'` event whose action is `presence.detached` is exempt from the residence
   check at ingest. It neither binds the seat to the pushing node nor is refused for a seat bound
   elsewhere.
2. `presence.attached` and `presence.reattested` keep the check. Those assert that a session is
   live as the seat, which is exactly what residence guards.
3. Every other ingest rule still applies to the detach: origin, team, dense `origin_seq`, replay.

## Consequences

- Moving a seat off a joiner no longer wedges that joiner's push queue on the seat's stale
  session. The old machine's row is cleared on the hub when its detach arrives.
- A node can now push a detach for a seat it never hosted. It removes nothing, because the fold's
  `node = origin` predicate matches no row, and it binds nothing.
- Other kinds a departed machine might write as a moved seat (lane transitions, messages) still
  refuse. Those do speak for the seat, and the move's push-and-save steer (ADR 696) is what drains
  them.

## Observability & Evaluation

- **Traces:** a joiner that would have wedged now logs `sync_pushed` where it used to log
  `sync_push_refused_residence` with `kind: presence`. The hub's `seat_nodes` row for the moved
  seat is unchanged by the detach.
- **Eval:** `sync/log.test.ts`: the old machine's detach is accepted without rebinding, and an
  attach or reattest as the same seat is still refused.
- **Experiment:** the next Air 2 move to `musterd-joiner-1` where the seat had a session on the
  Air. Falsify: the Air's `refused_json` naming that seat with `kind: presence` after this lands.
