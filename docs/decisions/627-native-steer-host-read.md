# 627 — A native steer arrives with the host's read of the act

- Status: accepted
- Date: 2026-10-15

## Context

[ADR 588](588-resident-byok-seat.md) §6 gave the resident seat an in-process doorbell. When an act
is raised at the seat while its loop runs, the bridge hears it on the seat's own socket and queues
the daemon-composed line as the loop's next user turn. The line follows
[ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) §4: it is built from structured fields
(sender, act, tier) and never carries the message body. To learn what the act says, the seat makes
a by-id read, `team_inbox_check {ids:[<act>]}`, which the line names.

On 2026-10-15 the pilot ran its pre-registered probe on the worker seat `mason` (lane
`01M4VTAEJZ`, measure 6). The pass condition was an in-thread answer before the seat's next model
call completes. It failed (lane `01M50GH51Z`):

| Event | ms after the steer was sent |
| --- | --- |
| `residency.steered` delivered | +503 |
| Model call 2 completes, without the steer | +5,047 |
| Model call 3 completes, holding the steer; its output is the by-id read | +8,107 |
| In-thread answer lands, after calls 4 and 5 | +15,281 |

Two costs show in the rows. A steer queued after a request has gone out waits for the next one;
that is the loop's shape and not something the host can change. The second cost is the pointer:
the seat spends one model call and one tool round reading an act the host already knew about.

## Problem

Remove the read round without opening the channel ADR 088 §4 closed. A teammate's body must not
reach a working seat with user-turn authority. A compromised seat could otherwise steer every busy
resident seat on the team.

## Decision

1. **The host makes the read the line names.** When the bridge delivers a raised act
   (`NativeBridge.onRaised`), it first runs `team_inbox_check {ids:[<act>]}` through the seat's own
   in-process adapter (`readSteeredAct`). That is the same tool, scope and render the seat's own
   call would use, so the result is what the seat would have read. A read that fails or comes back
   empty leaves the delivery as it was before this ADR, the line alone.

2. **The read enters the loop as a tool exchange, after the line.** The engine queues three
   messages together: the line as a user turn, unchanged; an assistant message holding exactly one
   call to `team_inbox_check` with those arguments; and that call's result. The body reaches the
   model only as a tool result, the channel and authority the seat's own read has. The line never
   carries the body, so ADR 088 §4 still holds for every line on every row.

3. **The record says the host made the call.** No model produced the injected assistant message.
   It has zero usage and is never a `wake_turns` row, a turn, or a cost. The turn transcript keeps
   it apart from the model's own `assistant` field, as `host_reads` entries keyed to the line they
   followed. Rehydration replays each one as the tool exchange it was, after its line.

4. **The queue drains whole.** The pi agent runs with `steeringMode: 'all'`, so the line, the call
   and the result reach the same request. Several acts raised before one request now arrive
   together rather than one per request.

This applies to the native row only. Hooked harnesses (Claude Code, Cursor, opencode) deliver the
line on a tool result and the model makes its own read; nothing there changes.

## Consequences

- A steer that reaches the queue before a request goes out is answerable on that request. The
  probe's remaining cost is the loop's own: a steer that lands while a request is in flight waits
  for the next one.
- The model sees a tool call in its context that it did not make. That is the price of keeping the
  body out of the user role. The line it reads just before names exactly that read, so the context
  reads coherently. The transcript keeps the provenance, so an auditor reading `wake_turns` can
  tell the host's call from the model's.
- Draining the steering queue whole changes the native loop only when several acts are raised
  within one request. Before this ADR they reached the model one request apart.
- A by-id read answers a steer (ADR 088 Amendment 5), so the host's read now discharges the steer
  where before the model's own read did. The steer is discharged even if the model then ignores
  it. That matches what a steer means once it is in context, and the in-thread answer, not the
  discharge, is what the probe and the steering metrics read. An ask or acceptance is not answered
  by a read, so those stay open until the seat replies, as before.
- The pilot's probe has to be re-run on a build containing this change. The pilot lane records the
  merge time, so the finding can split latency into before and after.

## Observability & Evaluation

- **Traces.** Each delivery still writes one `residency.steered` row. The host's narrator line now
  ends `with the host read` when the read rode along. The turn transcript carries `host_reads`.
- **Eval.** `pi.test.ts` pins that a steer carrying a read reaches the next request as line, call
  and result, that the model answers on that request, and that no user turn holds the body.
  `rehydrate.test.ts` pins the replay order. `nativeBridge.test.ts` pins the read's tool, arguments
  and its never-throw fallback.
- **Experiment.** Re-run the pilot's measure-6 probe on mason after this lands: a `steer` sent
  while a `wake_turns` row shows the seat inside a tool call. It passes if the in-thread answer
  lands before the next model call after delivery completes. Falsify it with any re-run probe whose
  answering turn is preceded by a model-made `team_inbox_check` of the steer's id.
