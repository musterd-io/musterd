# 672 — The spend-approval hold needs no session lease: the threshold rides the wake order, and the hold's acts authenticate under the wake lease

- Status: accepted
- Date: 2026-10-19
- Lane: `01M55Y58R3D1CCBERNJCXBJZQ9` (goal `cloud-agents`)
- Builds on: ADR 636 (the hold), ADR 337 (seat credential + session lease), ADR 241 (a wake is
  identified by its lease, attested on the seat's Presence), ADR 395 (the actuator's host key),
  ADR 671 (the actuator's roster read on Cloud)
- Amends: ADR 636 Decisions 1–2 (how the host learns the threshold and the seat's kind); ADR 337
  Decision 3 (one more way an agent-seat credential is proven live)

## Context

ADR 636 arms a per-wake spend-approval hold in the metering gateway: at wake start the host reads
the seat's kind from the roster and the threshold from `GET /report` with the seat credential; when
the running cost reaches the threshold the gateway holds the model call and the host sends one
blocking `ask` as the seat, then peeks the seat's inbox for the verdict.

Every one of those seat-credential calls is a routine agent HTTP request, and ADR 337 §3 requires a
session lease with it. The host has none, and must not mint one: a claim would occupy the seat the
wake's own session is occupying — manufacturing the very Presence the ADR 241 verifier reads.

So the hold has never armed on any host. This laptop's `~/.musterd/host.log` reads
`spend approval policy read failed for <seat>: missing agent session lease` for every seat, every
wake (miley, izzo, grokbot, dolly, 2026-10); the cloud pilot read the same line on its first wake
after ADR 671 (`pilot-2`, 2026-10-19 21:31Z). Had the read succeeded, the ask that follows would
have failed on the same rule.

## Problem

The host acts _for_ a wake, with the seat's credential and the lease the daemon handed it, and no
Presence of its own. The lease rule proves a caller is a live session of the seat; the host is not
one, but the wake it acts for is, and the daemon can see that on the roster.

Two reads are also one too many. The daemon knows the team's threshold and the seat's kind at the
moment it derives the order; the host re-deriving both through two authenticated reads (one of
which, the roster, needed ADR 671 on Cloud) adds failure modes to a fact the order can simply carry.

## Decision

1. **The threshold rides the order.** `WakeOrder` gains an optional `spend_approval_usd`
   (positive number). The daemon sets it when the team policy has `spend_approval_usd` (ADR 635)
   and the seat is an `agent` or `service` (ADR 636 §1); a human seat or an unset policy carries
   none. The host arms the hold from this field alone: no roster read, no `GET /report` read. An
   absent field arms nothing. Protocol schema change: additive, optional.
2. **The hold's acts authenticate under the wake lease, on two routes.** On `POST /messages`
   (the ask, and the held-outcome `status_update` and `message`) and `GET /messages` (the inbox
   peek) — and nowhere else — an agent-seat credential presented with `x-musterd-wake-lease` and
   _no_ session lease authenticates as the seat when two daemon-held facts agree: a `wake_leases`
   row with that id, minted for that member and not yet reported; and a fresh, unreleased Presence
   of that seat attesting exactly that lease (ADR 241's row). The Presence's attestation is
   client-side, so alone it is not evidence; the lease row is the daemon's. The request is
   presence-neutral by construction: the daemon creates and touches no Presence for it, because
   the wake's session is the occupant. Standing is judged as for any caller (left, halted — ADR
   501 —, disabled, banned, archived, lifecycle). A lease the daemon never minted, a reported one,
   another seat's, one no Presence attests, a released or stale Presence, or any other route is
   refused with its own sentence.
3. **The host's seat client sends the lease.** `HttpClient` gains `wakeLease`, sent as the ADR 241
   header on every request of that client (agent-seat credential only, as before). The loop opens
   the spend-approval seat client with the order's `lease_id`; the ask, the inbox peek, and the
   held-outcome `status_update` and `message` ride it.
4. **ADR 636 Decisions 1–2 are amended**: the kind and the threshold come from the order. The log
   lines `spend approval kind unread` and `spend approval policy read failed` are gone; the one
   remaining failure line is `spend approval seat unavailable` (no seat credential in the
   workspace), which leaves the wake on today's gateway as before.
5. **ADR 337 Decision 3 is amended**: a wake lease attested by a live Presence of the seat is the
   second proof, beside a session lease, that an agent-seat credential is acting for a live session
   of that seat. It carries no new actor — whoever holds the seat credential could already claim —
   and it ends with the Presence that attests it.

## Consequences

- A host that holds a seat credential and knows a live wake's lease id can post and read as
  that seat on the two message routes, without a Presence, for as long as the wake's session is
  present and the lease is unreported. The lease id is not a secret (it is on the roster); the
  credential is, and it is the same secret the host already keeps in the workspace binding, with
  which it could claim the seat outright. A separate host-only token minted with the order was
  considered and declined: it would add a second secret to hold without adding an actor the
  credential does not already admit. The window closes with the wake's Presence or its report.
- The host loop's spend-approval dependencies shrink: `memberKind` and `readSpendApproval` are
  gone; `spendApprovalSeat(workspace, team, leaseId)` is the one seam.
- `GET /report` keeps `wake.spend_approval_usd` for its readers (ADR 635); nothing reads it to arm.
- Tests: the order carries the threshold for an agent seat and never for a human
  (`store/residency.test.ts`); the wake-lease authentication is pinned on both drivers
  (`transport/wake-lease-auth-http.test.ts`): refused until a Presence attests the lease, then the
  ask posts and the inbox peeks with no Presence row added; a lease the daemon never minted, another
  lease id, a reported lease and a released Presence are refused; any other route (`GET /report`)
  keeps the lease rule; a session lease still works beside the header. The host arms from the
  order and opens the seat client for that lease (`host/loop.test.ts`).

## Observability & Evaluation

- **Traces:** on the host, `spend approval seat unavailable for <seat>` is the only arming
  failure left; a wake whose order carried a threshold and whose gateway held a call records the
  ADR 636 ask (species `approve`, tier `blocking`) from the seat, and `ask.held` on silence. On the
  daemon, a refused wake-lease request is the ordinary `unauthorized` with the sentence in
  Decision 2.
- **Eval:** the three test files above; live, a wake on `musterd-agent-pilot` with the team's
  `spend_approval_usd` below one turn's cost should show the ask in nick's inbox and the gateway
  holding until it is answered.
- **Experiment:** n/a — a fix to an authentication gap, judged by its tests and the live pilot.
