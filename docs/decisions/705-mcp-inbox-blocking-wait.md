# 705 — A blocking wait on the MCP inbox surface

- Status: accepted
- Date: 2026-10-21

## Context

Finding 019 (lane 01M5GVGTFH) costed CooperBench pilot 3: an agent waiting for its partner
had no way to block on the MCP surface, so it polled — 51 waits, 257 calls of
`team_inbox_check` / `lane_board` / `team_status` / `sleep N && git fetch`, 63% of inbox
checks returning nothing new, about $4.8 of musterd's $10.83 over the team arm. The CLI
already has the blocking form (`musterd inbox --wait`, ADR 054); MCP has none. ADR 588 §6
already gives the MCP client a live-socket directed-act listener (`onDirected`).

## Problem

An MCP agent that must wait for a partner can only poll, and every poll is a full model
call at full context. A new MCP tool for waiting would also add a schema to the surface
finding 019 (A) is trying to shrink.

## Decision

`team_inbox_check` gains an optional `wait` parameter (seconds), following `team_join`'s
`wait` precedent (ADR 095):

- `wait` absent or `0` is exactly today's behaviour.
- With `wait > 0` and nothing already waiting (buffered or fetched), the call blocks on
  the client's live-socket directed-act listener (`onDirected`, ADR 588 §6) until a
  directed act arrives or the budget runs out, then runs the ordinary check. No polling
  loop is introduced; if the socket was down, the fetch after the wait is the authority.
- The budget is clamped to 50s (`MAX_INBOX_WAIT_MS`), under the harness MCP tool timeout,
  so the call returns instead of being killed. Negative or non-finite values are refused.
- No new tool, no `@musterd/protocol` schema change: the parameter rides a hot tool that
  is already loaded, so the always-loaded surface does not grow a schema.

Waking on hold release or lane resolution (finding 019 fix C) is a later lane; this
decision covers acts addressed to the seat only.

Follows-up: 01M5GWB209A0JCK8ZCY77E3QY0

_(Amended 2026-10-21: fix C landed in lane 01M5GWB209 — `until_lane` on the same call
also wakes on the daemon's `lane_resolve` broadcast for a named lane and returns the
holder's branch; resolving the holder's lane is what releases its hold. A hold that
lapses because its holder left (ADR 693), with no resolve broadcast, still ends the
wait by timeout — the retry then meets the ADR 697 hand-over.)_

## Consequences

- An MCP agent waits for a partner in one call; the CooperBench harness lane
  (01M5GWB5GG) can name `wait` in the agent instructions instead of polling, and the
  N=20 claim run (01M5GWBB17) measures whether the counterfactual saving is real.
- A wait on a dead socket returns the ordinary empty reply at timeout rather than
  hanging; the act itself is never lost (server log + cursor are authoritative).
- 2026-10-22: the claim run measured the saving (finding 021: all 40 agents used `wait`,
  musterd's `core` cost fell from $24.59 to $17.29). Acceptance review (big-body) found a lost
  wakeup. The wait subscribed only after the empty pre-check, so an act delivered during that
  check fired no listener, and the wait slept to its timeout. The fix arms the wait (`armWake`)
  before the pre-check and cancels it when the check finds work. Two regression tests deliver an act
  and a lane resolve in that gap.

## Observability & Evaluation

- Traces: the wait is inside the existing `team_inbox_check` call, so existing tool-call
  telemetry counts it as one call instead of the 257-call poll pattern.
- Eval: `packages/mcp/src/tools/inboxCheck.wait.test.ts` covers the resolver (clamp,
  rejection), wake-on-directed, timeout, and already-waiting cases.
- Experiment: the CooperBench re-run on the build with fixes A+B (lane 01M5GWBB17,
  pre-registered) is the measured check that the $4.8 counterfactual holds.
