# 688 — A decided pull window closes its ask, and an unredeemed grant cools the pair down

- Status: accepted
- Date: 2026-10-20
- Lane: 01M5DT2PT795EAD4YSNJ0W9QKN
- Amends: [ADR 645](645-pre-registered-work.md) Decision 4 (the window) and Decision 8 (rate)

## Context

ADR 645's band-2 pull announces "host X proposes seat Y for lane Z" to the lane's opener as a
directed `ask` from the host's service seat, watches the window on the hub, and on silence grants
the pair; the host then claims as the seat. A grant nobody redeems in 15 minutes is declined
(`grant not redeemed`) and the lane is offered again — on the next poll, to the same host.

The announcement is an obligation-class act (ADR 429): the opener's inbox pins it until an
accept/decline names it, a reply from the opener lands in its thread, or a `resolve` closes the
thread. The window decides itself; nothing ever did any of those three.

## Problem

On 2026-10-20 the one pre-registered lane on this team (01M49HHJQF, reads_on that day) was offered
by four hosts, granted on silence every window, redeemed by none, declined on the TTL, and offered
again on the next poll: 60 `lane.pull_declined` rows, every one `grant not redeemed`, one
announcement ask to the opener roughly every 20 minutes per host, from 07:20 until the lane was
claimed by hand. Every one of those asks stayed open. The lane landed in #3058 and hours later
the opener's inbox still pinned dozens of "proposes seat" asks for it, and a `decline` on one of
them cleared only that one. The one person the window exists to inform was the one person it
buried.

Two defects, one per decision below. Why the hosts never redeemed their grants is a third
question (host-side: no seat credential in the workspace binding, or the claim refused) and is
not answered here; whatever the reason, re-asking the opener every window is not the response.

## Decision

1. **A decided window closes its ask.** When an announcement leaves `announced` — granted on
   silence, or stopped by a steer, a decline, a claim, or a change to the lane — the hub has the
   same host service seat send a `resolve` on the ask's thread to the same opener, body
   `pull window closed: <outcome>`, `meta.pull` stamped like the ask. The thread resolve is the
   discharge the pinned set and the ADR 090 ledger already read; nothing new is taught to the
   inbox. The later TTL decline of an unredeemed grant adds no second close. The resolve is
   best-effort: the window's decision stands if it cannot be sent. It carries no `urgent`, and
   the idle seam already refuses it as it refuses the ask.
2. **An unredeemed grant cools the (lane, host) pair down.** A host whose grant for a lane was
   declined `grant not redeemed` is not offered that lane again for `PULL_REOFFER_COOLDOWN_MS`
   (6 h — one more try per working day per host, not one per poll). Another host may be offered
   the lane at once; the cooldown is on the pair, not the lane. The poll's `idle_reason` says how
   many eligible lanes are cooling.
3. **The daily cap counts announcements.** ADR 645 §8's per-seat daily cap is read from the
   `pull_announcements` rows themselves, by member id, not from the `residency.pull_offered`
   audit projection of them. The rows are the record; the audit row is a trace of it and may be
   pruned or absent on a replica.

## Consequences

- `packages/server/src/store/pull.ts`: `closeAnnouncementAsk` in `sweepPullWindows`,
  `unredeemedWithin` in `offerPull`, `offersToday` over the table, and the two exported
  constants. No protocol change: `resolve` on a thread is ADR 025's act, and `meta.pull` is the
  stamp ADR 645 already defines.
- A host that cannot redeem grants now announces at most four times a day per lane (6 h cooldown)
  instead of once per window, and each announcement is closed when its window is. The opener's
  inbox carries one open ask per live window, never a backlog.
- The asks already open on the board from before this landed are not closed by a backfill
  resolve. _(Amended 2026-10-21, lane 01M5G34H: they did not age out on read. A pull ask is
  obligation-class, so reading it leaves it pinned, and a decline addressed to a host seat that
  has left was refused `no member`. The pinned set now drops a pull ask whose lane is claimed or
  no longer open, and an accept or decline naming that ask may be addressed to the host seat
  after it has left. `closeAnnouncementAsk` sends its resolve from that seat even when `left_at`
  is set.)_
- Follows-up: why the four hosts never redeemed a grant is its own read — the host logs
  (`! pull claim refused …` / `no seat credential …`) say which. Lane to be opened by whoever
  owns the hosts.

## Observability & Evaluation

- **Traces:** `resolve` acts with `meta.pull` (one per decided announcement); `lane.pull_declined`
  rows with reason `grant not redeemed` per (lane, host) per day, which Decision 2 bounds at four;
  the poll's `idle_reason` naming cooling lanes.
- **Eval:** on the next pre-registered lane this team offers, the opener's inbox shows at most one
  open announcement ask per host at any time, and `lane show` on it carries ≤ 4 `pull declined`
  edges per host per day. `pull.test.ts` pins: resolve on grant and on stop, no second close on the
  TTL decline, the ask unpinned after the decision, cooldown per host, and no interrupt from the
  resolve.
- **Experiment:** n/a — two read bugs with one correct answer each.
