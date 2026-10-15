# 609 — A wake displaces only what snuck into its lease window

- Status: accepted
- Date: 2026-10-15
- Lane: `01M50C7QK004WDW4TFV7MHBGZ7`
- Amends: ADR 444 (bounded — see the amendment dated 2026-10-15 there)
- Decided with: nick (options presented this session: this, defer-when-squatted, host stand-down)

## Context

ADR 444 gives an attended session absolute protection: a wake or dream claim that settles to
provenance `wake`/`dream` is refused while any live presence row of the seat is not itself a wake
or dream — "a wake never displaces an attended session." The rule exists so a person working at
3am is never killed by a daemon wake.

Recorded in [docs/wiki/dream-adapter-cannot-take-seat.md](../wiki/dream-adapter-cannot-take-seat.md):
on lazara's Claude Code dream wakes (2026-10-08, 2026-10-12) the seat was occupied by a `session`
row that **attached ~12 seconds after the daemon minted the dream lease** — a resident/zombie
adapter (surface `cursor`, `wake_lease` null) re-attaching into the spawn window. The dream's
`team_join` presented a valid dream lease and was refused by the 444 gate; the session ran pending
all night, every write fell to the CLI, and Presence never showed `dream`.

## Problem

The 444 gate compares only provenance, never time. But the daemon mints a lease only after
observing the seat idle (`dreamBlocker`: not live). A session row that attaches *after* that
observation did not exist when the decision was made — it snuck into the spawn window between the
lease and the claim — and treating it as an attended session the daemon saw and chose to spare
inverts the facts. With a persistent adapter in the loop (resident seats, hosted-seat goal), the
sneak wins the race every night and the seat never dreams: the protection rule becomes a
denial-of-dream rule.

## Decision

A wake or dream claim presenting **its own daemon-minted lease** displaces a live attended row
only when that row attached **after** the lease was minted (`presence.created_at >
wake_leases.created_at`). Everything else about ADR 444 stands:

- an attended row that attached **at or before** the lease mint is protected absolutely — the
  claim is refused exactly as before;
- a claim settling to `wake`/`dream` **without** presenting a lease of this seat's is refused
  exactly as before — the window opens only for the authority the daemon actually minted;
- the displaced rows ride the existing machinery: the `superseded` frame naming the successor,
  the connection closed, the `claim.superseded` audit row with the displaced sessions
  ([ADR 237](../decisions/)'s ledger), and the freed session re-claims with one `team_join`.

Both claim transports (WS `hello` and `POST /claim`) apply the same verdict from one helper
(`attendedSessionRows` + `ownLeaseCreatedAt`), and the occupy-time displacement loops evict a
window row **even in the claim's own workspace** — the ADR 092 same-workspace sparing protects a
live predecessor of the *same logical session*, not a different session that snuck the seat.

## Consequences

- The zombie/race case self-heals: the dream takes the seat it was leased, the squatter is told
  (`superseded` names the dream) and re-claims — for a zombie adapter, into the pending it should
  have been; for a person, with a one-line explanation of what happened.
- The amendment narrows ADR 444's protection by exactly the race window: a session the daemon
  could see when it decided is never displaced by a wake. The window cannot be widened by an
  attacker without the team agent key *and* a daemon-minted lease, and a lease is minted only
  against observed idleness — the mint is the evidence the displacement cites.
- A person who opens a session in the spawn window and is actively typing when the claim lands
  can be displaced. This is the known cost, judged acceptable against a seat that never dreams;
  the superseded frame is the mitigation, and the window is seconds wide — measured: the recorded
  sneak attached ~12s after the mint (lazara 2026-10-12, `attached_at` 12s after the lease start).
- _(Correction 2026-10-15, on dolly's review of #2653: the Decision's `[ADR 237](../decisions/)`
  link points at [ADR 237 — supersession must be visible](237-supersession-must-be-visible.md).
  Left in place there — the Decision is frozen — and recorded here.)_
- lazara's surface-attestation sub-claim on the wiki page (a wake adapter attesting `cursor`) is
  **not** decided here — that row is about `resolveLaunchSurface` and stands.

## Observability & Evaluation

- **Eval:** the wiki claim's falsifier inverts — on the next lazara dream wake, the first `team_*`
  call claims the seat and Presence shows provenance `dream` (previously: refused, pending). The
  `claim.superseded` audit rows with `successor_provenance: dream` and a displaced `session` row
  are the recurring check; `claim.refused {reason: attended_session}` on a window row would
  falsify the fix.
- **Traces:** existing audit rows only (`claim.superseded`, `claim.refused`) — no new emission
  points.
- **Experiment:** n/a — observable on the next resident dream night.
