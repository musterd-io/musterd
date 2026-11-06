# 816 — The hub starts and stops Fly seat machines: scale-to-zero for cloud seats

- Status: proposed
- Date: 2026-11-06

## Context

Lane `01M64B25QMR402P4BNE5V17CER` (nick, stated): the hub starts a stopped agent machine when a
wake is due for a seat resident there, and the machine stops when no seat is mid-wake. Fifty's
2026-11-01 reading in that lane said park it — one Fly seat, a few dollars a month, against an ADR
for a hub-held Fly credential. Nick re-asked on 2026-11-05, and fifty named it the first
cloud-agents priority on 2026-11-06 (it is what makes phase 2a, one machine per team, affordable).
This ADR is the credential and control decision that reading deferred to.

Measured 2026-11-06 (full reading in `docs/perf/cloud-seat.md`, same date):

- `delta-2` is the only Fly seat machine: `musterd-agent-delta-2`, machine `87e126c01399e8`, `sjc`,
  shared-cpu-2x / 2048 MB, one attached 3 GB volume, `started` since 2026-10-27 (relaunched
  2026-11-04). Wake report for the last 7 days shows **zero wakes** for the seat.
- At Fly's current published rates (fetched 2026-11-06; list price, not an invoice — the same
  provenance as the 2026-09-14/15 readings, whose invoice falsifier is still unrun): always-on is
  **$13.84/month ≈ $0.46/day** ($13.39 machine + $0.45 volume). Stopped is **~$0.53/month**
  (rootfs at $0.15/GB/month on the earlier machine's measured 506 MB image, plus the volume).
  Scale-to-zero at delta-2's observed utilisation saves ~96% of the machine line.
- Wakes are pull-based (ADR 395): the actuator on the machine polls `/residency/wake-leases`. A
  stopped machine polls nothing and cannot be woken — proven 2026-09-15
  (`docs/perf/cloud-seat.md`: the act was deferred, not lost). Nothing in the repo calls the Fly
  Machines API to start a seat machine; the only start today is a human running `fly machine start`.
- The daemon that mints wake leases already holds every fact the decision needs: residency rows
  carry the `host` label (`packages/server/src/store/residency.ts`), `host_liveness` records each
  host's last poll, and `liveLease` is the mutual-exclusion read. In hub mode (delta-2) that daemon
  is the hub on `musterd-joiner-1`; the machine's own joiner daemon folds from it.
- Fly's own auto-stop/start keys on inbound HTTP traffic. The cloud-agent app has no `[[services]]`
  block — nothing listens (`deploy/cloud-agent/fly.toml`) — so Fly cannot do this for us.
- Leases are claimed at poll time, never minted ahead (`claimWakeLeases` runs inside the
  `/residency/wake-leases` POST), and attempts are counted from `residency.woke` /
  `residency.wake_failed` audit rows (`attemptsForAct`). A stopped machine polls nothing, claims
  nothing, and writes neither row — stopped and starting time already consumes no attempt budget
  and no deferral snooze. Rule 4 is therefore a constraint on the start trigger (it must not mint
  leases early), not new accounting. Periodic daemon sweeps already have a home:
  `packages/server/src/protocol/*Watch.ts`, registered per mode in `cloud/loops.ts`.

## Problem

Making a stopped seat wakeable needs a push path: someone off the machine must call the Fly
Machines API when a wake falls due, and call stop when the machine is idle. That someone holds a
Fly credential powerful enough to start and stop machines. Where that credential lives, what it may
touch, and which state machine may spend it are undecided — and the wrong answers are quiet ones:
a token in the team store replicates to every joiner; a token on the seat machine can stop but
never start its holder; a stop rule that races a claimed lease destroys a wake mid-flight.

## Decision

1. **The lease-minting daemon owns start and stop.** The same daemon that decides a wake is due
   (the hub, or the hosted team's server) calls the Fly Machines API. No second actor — not the
   seat machine, not an operator script, not a cron — holds start/stop authority.
2. **One credential, hub-local, never replicated.** The daemon reads an app-scoped Fly token from
   its own process environment (`MUSTERD_FLY_API_TOKEN`), staged the same way other daemon-box
   secrets are (0600, service env). It is never written to the team store, team policy, an act, or
   a log line — the store replicates to joiners, so anything stored there is on every machine by
   construction. One token per Fly app, scoped to that app, so a leak starts/stops one seat's
   machine and nothing else. Absent token ⇒ the feature is off and behaviour is exactly today's.
3. **The host-label → machine mapping is daemon-local config**, beside `rosterHome` in the daemon's
   `config.json`: per team, `flyMachines: { <hostLabel>: { app, machine } }`. It is an operating
   fact about the hub box, not team state, so it does not enter the store or the protocol. A host
   label with no mapping is never started or stopped.
4. **Start rule.** When residency finds a wake due for an enrolled seat whose `host` label maps to
   a machine reported `stopped`, the daemon starts it (Machines API, idempotent — `started` is a
   no-op) and writes an audit row either way. Start failure never blocks act ingest and never loses
   the act: the wake defers exactly as it does today for an offline host. Time spent stopped or
   starting does not consume wake attempts — a lease is offered when the host next polls, so boot
   plus fold-drain cannot burn the act's attempts before the actuator exists to claim them.
5. **Stop rule.** The daemon stops a mapped machine only when all hold: the host has polled at
   least once since this start (boot completed); no live lease exists for any seat on that host;
   no wake activity (claim or completion) for that host inside the idle window (default 15 min,
   config); no directed-undelivered act waits for a seat on that host. The machine never stops
   itself and holds no Fly token. An act arriving in the same tick as a stop re-triggers rule 4 —
   the cost of a wrong stop is one cold start, never a lost act.
6. **Bounds.** Start calls are rate-limited per machine (a flapping start is an audit-visible
   defect, not a loop): exponential backoff on repeated start failure, and a per-machine hourly
   start cap, both in config with conservative defaults. Every start/stop attempt and outcome is an
   audit row (`fly.machine_start`, `fly.machine_stop`, with the Fly status on failure).

Alternatives considered:

- **The seat machine stops itself** (its host loop knows its own idleness best). Rejected: it
  cannot start itself, so the hub needs the credential regardless — this would put a Fly token on
  the least-trusted machine in the system to save the hub inferring idleness it can already read
  from lease and liveness state.
- **Fly `[http_service]` auto-stop/start.** Rejected: it needs a listener to key on. Adding one
  changes the machine's attack surface to save a state machine the residency store already has.
- **An operator-side watcher** (a script polling the hub and Fly). Rejected: a second brain
  outside residency state, racing leases it cannot see atomically, and a second place the
  credential lives.

## Consequences

- A stopped cloud seat becomes wakeable without a human, at cold-start latency instead of poll
  latency. The lane's falsifier stands: if act→reply on a cold start regularly exceeds ~2 minutes
  (Fly start + tailnet + daemon boot + fold drain + first poll), the saving is bought with
  reachability and this decision is revisited. Boot-to-polling was ~8 s to daemon-up on
  2026-10-28; fold drain is the unbounded term and the one to watch.
- The hub box gains one new secret and one new outbound call. Both are named here rather than
  accreting silently: rule 2 is the whole credential story, and `deploy/cloud-agent/README.md`
  documents staging it when the implementation lands.
  Follows-up: 01M64B25QMR402P4BNE5V17CER
- Phase 2a (one machine per team) inherits this unchanged: more mapped host labels, same rules.
  Per-team machines are the case where always-on pricing stops being a rounding error.
- Observed while measuring, not part of this decision: a second, detached 3 GB `agent_data`
  volume on `musterd-agent-delta-2` bills $0.45/month attached to nothing.
  Follows-up: deferred — delete once the 2026-11-04 relaunch no longer needs a rollback volume (2026-11-06)
- The list-price basis of every number here carries the standing falsifier from 2026-09-14: read
  the Fly invoice for the period; a >20% difference means the rates are wrong for this account.
  It needs a human at the dashboard — Fly's GraphQL exposes no invoice or usage fields
  (introspected 2026-09-15) and there is no billing verb in `fly` (checked again 2026-11-06).

## Observability & Evaluation

- Traces: every start/stop attempt is an audit row (rule 6) with the machine, the triggering
  seat/act, and the Fly outcome; wake latency splits (act→start, start→first-poll, poll→reply)
  derive from existing `residency.*` rows plus these, and land in `musterd report residency`'s
  by-seat output rather than a new surface.
- Eval: two weeks on delta-2 after the implementation lands — running hours/day, cold
  act→reply p50 against the ~2 min falsifier, count of stop-then-immediate-restart flaps
  (target zero), and the realised machine line against the $13.84/month always-on baseline.
  Results append to `docs/perf/cloud-seat.md` beside the reading that priced this.
  Follows-up: 01M64B25QMR402P4BNE5V17CER
- Experiment: n/a — one machine, one seat; there is no population to split. The eval above is a
  before/after read on the same machine, and its baseline (always-on, zero wakes in 7 days) is
  already recorded.
