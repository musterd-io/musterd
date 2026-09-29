# 471 — A binding rewrite carries the session lease forward, and an explicit `team_join` verifies instead of answering "already"

- Status: accepted — 2026-09-28
- Date: 2026-09-28
- Lane: `01M3N79FWR85B7B55WDE01H6XT` (goal `seat-continuity`)
- Amends: [ADR 377](377-one-name-for-seat-occupancy.md) (`--detach` "writes no lease" becomes "holds no
  lease and keeps the one on disk"), [ADR 337](337-agent-http-session-authority.md) (who may erase a lease
  from a binding). Completes lane 01M2GP25R3 clause 8 (the explicit-join verify that the tool never
  reached).

## Context

The CLI hook probe (`musterd inbox --interrupt-check`) authenticates with the `session_lease` it
reads from this folder's `binding.json`. That lease is minted for the harness adapter's Presence and
renewed over the adapter's socket (ADR 337/347); the adapter writes it to the binding so the hook in
the same folder can present it. When the probe is refused, the hook prints the deaf line and
prescribes `team_join` as the repair.

Measured 2026-09-28 (dolly, Claude Code Desktop): a healthy session ran `musterd claim dolly
--detach` from its own folder. The detached claim (`detachedClaim`) builds a fresh `Binding` with no
`session_lease` and saves it; `saveBinding` carried `session`, `seat_credential`, `model_observed`
and `host_key` forward across such a rewrite — but not the lease. The adapter's Presence and lease
were alive on the server; only the copy on disk was gone, so every hook probe from then on was
refused. `team_join` answered "Already joined revive as dolly." and changed nothing: the tool
returns from the in-process `joined` flag before it reaches `claimAndJoin`'s verify path — the very
short-circuit lane 01M2GP25R3 diagnosed, tested at the `claimAndJoin` layer, and did not remove
from the tool. `team_leave` then `team_join` re-minted and re-wrote the lease and the line went
quiet.

The same "Already joined" no-op had already been measured on a dead Presence (izzo and stanley,
2026-09-14; `docs/wiki/cloud-seat-from-inside.md`). Two different faults, one prescribed repair
that repaired neither.

## Problem

`claim --detach` erases the adapter's lease from the binding while the Presence it belongs to is
alive; and the explicit `team_join` the deaf line prescribes never consults the server, so it cannot
repair either a dead Presence or an erased lease.

## Decision

1. **A binding rewrite that carries no `session_lease` keeps the one on disk for the same claimed
   seat.** Both `saveBinding`s (`@musterd/cli` `config.ts`, `@musterd/mcp` `binding.ts`) apply the
   same rule they apply to `seat_credential`: carried forward when the writer omits it and
   `bindingSeat` matches; never to a different seat; an explicit lease on the argument still wins.
   The adapter's socket (`occupied` and `lease` frames) remains the only writer of a *new* lease.
   `--detach` therefore holds no lease of its own and no longer erases the adapter's.
2. **An explicit `team_join` while `client.joined` verifies with the server and re-writes the
   lease.** It makes one authenticated read on the route the hook probes
   (`GET /inbox/interrupt-check`, via `request()`, whose lease-refusal recovery re-joins for real
   when the Presence is gone), then `persistRenewedLease` writes the live lease back to the binding.
   The reply says which case it found: verified live, re-occupied, or re-join failed. A raised
   interrupt line found on the way is appended to the reply rather than dropped. Autojoin is
   untouched: it still reuses without a round trip.
3. The deaf line's last clause reads "`--detach` holds none" (it was "writes none", which was true
   and hid the erasure).

## Consequences

- A seat that runs `musterd claim <seat> --detach` in its own folder stays audible on the interrupt
  line. A seat that finds itself deaf and calls `team_join` gets a repair, and a reply that says
  what was repaired.
- The **attached** CLI claim (`musterd claim <seat>` without `--detach`) still writes the lease its
  own socket minted, which dies with the command (ADR 337) — it overwrites a live adapter lease
  with a soon-dead one. Not changed here: the doctor and the deaf line already say not to run it
  from a folder an adapter holds, and changing what an attached claim persists is ADR 377's call.
- An explicit `team_join` costs one HTTP round trip more than before when already joined. It is
  rare (autojoin covers the common path), and the round trip is the point.

## Observability & Evaluation

- **Traces.** None added. The verify read is an ordinary `inbox/interrupt-check` request; a re-join
  it triggers audits as any reconnect claim does (`claim.superseded` / `agent_session_lease.minted`).
- **Eval.** Unit: both `saveBinding`s carry a same-seat lease across a lease-less write, never to
  another seat, and an explicit lease wins; `claim --detach` in a folder bound with a lease leaves
  that lease in place; end-to-end against a real daemon, `team_join` → erase the lease on disk →
  `team_join` again answers "Already joined … Verified live with the server" and the binding holds
  the client's lease once more. Baseline: before this ADR the second join's reply carried no verdict
  and the binding stayed lease-less.
- **Experiment.** Falsifier: a seat whose hook prints the deaf line, calls `team_join` alone in its
  own turn, and still prints the deaf line on the next tool call. Watch the first few deaf-line
  reports after this lands (`docs/wiki/cloud-seat-from-inside.md` keeps the trials).
