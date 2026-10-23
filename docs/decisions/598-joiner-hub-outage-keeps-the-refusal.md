# 598 — a joiner keeps the refusal through a hub outage, and the refusal says what still works

- Status: accepted
- Date: 2026-10-14
- Builds on: [ADR 325](325-multi-machine-federation.md) (§Offline semantics, and its Experiment: reconsider provisional claims "with that evidence in hand"), [ADR 355](355-hub-arbitrates-a-joiners-claim.md) (the claim behind the hub; `hub_unreachable`), [ADR 361](361-every-ownership-edge-is-the-hubs.md) (release, handoff, submit and close follow it), [ADR 203](203-a-claim-refuses-a-lane-a-live-teammate-owns.md) (the double claim this guards)
- Lane: `01M4Y3BYDRRNG7903VZQ5HWB2Z`

## Context

Asked by nick on 2026-10-14, after the hub question: with the hub down, nobody on a joiner can take or finish a lane. Every seat now lives on a laptop and the hub is one machine that reboots, which is the situation ADR 325 priced in advance and said it would revisit if "partitioned machines routinely find lanes unclaimable at the moment work starts."

What a joiner does while the hub is unreachable today (ADR 325, 355, 361): messages, inbox, opening and editing lanes, and memory keep working and sync on return; claim, handoff, release, submit and close refuse with `hub_unreachable` (503, CLI exit 12) and the lane is left as it was.

The evidence on file, from the one joiner whose daemon log I could read (this seat's, `daemon.log.1`, rotated 2026-10-13/14): four `sync_claim_hub_unreachable` events in about two and a half hours on 2026-10-13 (18:47, 20:27, 20:30, 21:12 UTC), none in the current log. All four are `TimeoutError` after the 10 s `CLAIM_TIMEOUT_MS`; none is a refused connection. That is a slow or stalled hub, not an absent one, and it is one machine's view over about a day, so it neither shows routine pressure nor rules it out. The asks and status complaints ADR 325 named as the signal are one: this lane.

## Problem

Choose between (a) a provisional claim, submit and handoff on the joiner that the hub arbitrates on reconnect, and (b) keeping the refusal and making it say what works. Separately: the refusal as shipped does not say.

## Decision

### 1. Keep the refusal. No provisional claim, submit or handoff.

A provisional claim is a claim the seat is invited to build behind and may lose. Its cost is a seat's hours on a lane another seat owns, the failure ADR 203 was written for (the 2026-08-01 double claim, two seats, six minutes apart) and the one ADR 325 declined to reintroduce across machines. Under (a) the loser keeps its branch and is told it was superseded; that bounds the loss and does not remove it, and a hub outage is exactly when the machine that does not know about the other claim is most likely to take the same lane the hub machine's seats are taking.

What the evidence supports is a smaller claim than "the refusal is wrong": during the observed window the hub was slow, not gone. The change worth making is to the sentence, and to one honest gap below (§3).

### 2. The refusal names what happened, what waits and what still works

`HubUnreachableError` (every joiner→hub forward: claim, handoff, release, submit, close, policy, holds, style, halt) now says:

- the hub was unreachable, or did not answer in time (a timeout is named as one);
- **nothing was recorded here**;
- claim, handoff, release, submit and close wait for the hub;
- messages, inbox, opening and editing lanes, and memory keep working and sync when it returns.

No protocol change: the code, status and exit number are as before; only the message string differs.

### 3. A timeout is not a refusal, and the sentence says so

A call that times out at 10 s may have reached the hub. The hub's write is atomic and the joiner's row converges from the fold, so the claim can hold at the hub while the seat was told it failed, and the next pull then shows the seat owning the lane. A blind retry in that window carries the joiner's stale read (`expect: unowned`), so the hub answers `409 conflict` naming the seat itself as the holder (`claim.ts`, the `LaneConflictError` path) — correct, but it reads as a refusal when the claim in fact held. The timeout sentence therefore adds: the hub may have received this before the timeout — read the board before retrying. Treating a retry whose actual owner is the asking seat as success is a behaviour change to the CAS and is not made here.

## Alternatives considered

- **(a) Provisional claim reconciled on reconnect.** Refused for the reason in §1. If it is revisited, the conflict story to design is the loser's branch and the winner's lane, not the happy path.
- **Raise `CLAIM_TIMEOUT_MS`.** Treats the one observed failure mode and leaves a seat's call hanging longer; not taken without a measured hub p99.
- **Offline-only submit.** Submit is where work already done is lost if it cannot be recorded, and it is the cheapest edge to make provisional (no incumbent to displace). Not taken here because a submit moves the lane to acceptance, which routes a human or a peer to judge it against a hub that is not there to record the verdict.

## Consequences

- An enrolled joiner still cannot claim, hand off, release, submit or close while the hub is unreachable. The message now says so and says what works.
- The decision is falsifiable in use. Reconsider (a) when either: a joiner log shows `sync_claim_hub_unreachable` as a refused connection (a true outage) on more than one day, or two seats report the refusal as the reason they stopped work. Both leave a trace: the log line, and `team_send` text naming it.
- `docs/architecture/03-server.md` (`claim.ts`) and `docs/design/deployment-topology.md` carry the same sentence about the offline rule.
- The two-daemon test the lane asked for (hub stopped, joiner claims, hub returns, one winner) is not built, because nothing is provisional to arbitrate. The refusal wording is covered by a unit test on `HubUnreachableError`.
- _2026-10-23 (lane 01M5N3SMBM):_ a joiner with Tailscale stopped failed every submit as "did not answer in time", and the cause was never named: the hub's 100.x address is only routable over the tailnet. The message's rule stands. It now also says why, from `sync/hubDiagnosis.ts`. The fetch errno is kept and sorted into timeout, refused, unroutable or DNS. Only after a failure, for a tailnet hub, this machine's Tailscale is read. When Tailscale is stopped or absent, the message names that and how to start it, and drops "the hub may have received this": the request never left the machine. The `sync_*_hub_unreachable` lines now carry `code`. The joiner's `musterd status` line for the hub is a follow-up lane (01M5N3TC6B).

## Observability & Evaluation

- **Traces.** `sync_claim_hub_unreachable` (warn) on the joiner, with `err` carrying `TimeoutError` or the connection error. This ADR adds no new line; it makes the existing one separable into timeout and refused-connection. _(2026-10-23: the lines also carry `code`, the errno or `TimeoutError`, so the split no longer depends on reading `err`.)_
- **Eval.** Unit test on `HubUnreachableError`: the timeout and connection-refused messages each name that nothing was recorded, the five waiting edges and the working ones; only the timeout names the possible receipt.
- **Experiment.** Prediction: over the next two weeks of joiner logs, `sync_claim_hub_unreachable` stays a handful per day and is timeout-shaped. Falsify: a refused-connection line on more than one day, or a seat stopping work on the refusal (§Consequences).
