# 501 — Halt as revocation: a human-only stop that revokes a seat's authority mid-work

- Status: accepted
- Date: 2026-10-03
- Deciders: nick (halt is in, human-only, sponsor-scoped; approved the spec 2026-10-03)
- Lane: `01M3TAKKMMSTV14A3NVVWFCJT8` (goal `launch`)
- Spec: `docs/superpowers/specs/2026-10-03-halt-as-revocation-design.md` (#2025)
- Builds on: `docs/design/2026-09-01-human-surface.md` §3 (DECIDED: two builds, revoke-the-lease
  first), ADR 150 (PreToolUse gate), ADR 337 / ADR 347 (session leases), ADR 131 (residency and
  wake leases), ADR 164 (session-attested presence), ADR 456 (sponsored cascade), ADR 463
  (sponsor-scoped authority), ADR 407 (visibility team-wide, delivery addressed)
- Protocol change: yes (hard rule 1) — `Member.halted`, `Member.can_halt`, claim refusal `halted`

## Context

The human-surface design decided that a human must be able to stop an agent, and that "stop" is
three verbs. The one nick pictured — halt this turn — decomposes into two builds: revoke the
seat's authority at the next boundary (coordination-shaped, mostly built), and a live channel
into the harness process (a new security surface with its own argument). This ADR is the first.

Everything halt needs already exists as a mechanism with one caller or none: session leases
(ADR 337/347) are revoked today only on credential rotate; the hub evicts a presence with a reason
string only on member removal; `memberStandingRefusal` is the single place every authenticated
call checks a member's standing; the ADR 150 gate fronts every tool call and fails open; wake
leases (ADR 131) are claimed per seat by a host. Nothing ties them to a human's decision.

The authority question was deferred by the human-surface design to the second-human dogfood.
Nick decided it on 2026-10-03 for this build: sponsor-scoped for non-admins, admin-wide — the
ADR 463 model, already enforced server-side for credentials, grants and residency.

## Problem

A human watching an agent go wrong has no way to stop it that musterd records. Killing the
process is invisible to the team and to the seat; disabling the member is governance (it cascades
to sponsored chains and needs a re-mint to undo); releasing the lane does not stop the seat.
There is no standing that says "this seat is stopped, by whom, why, until a human says
otherwise," and no surface that refuses on it.

## Decision

1. **Halt is a standing on the member, not a lifecycle state.** Three nullable columns on
   `members`: `halted_at`, `halted_by` (the human's member id), `halted_reason` (required,
   ≤ 280 chars). Halted is derived from `halted_at`, as "left" is from `left_at`. It is not an
   `account_status`; it never cascades, never touches credentials, roles or lanes, and is lifted
   by a human or stays.
2. **Human-only, sponsor-scoped, admin-wide; enforced server-side.** `POST
   /teams/:slug/members/:name/halt {reason}` and `.../resume` pass only when the caller is a human
   member in good standing **and** either an admin or the target's sponsor (`sponsored_by ===
   caller.id`), and the target is an agent. A human seat is never halted. An agent can never halt.
   Any human who could have halted a seat may resume it. The CLI and /live never decide this.
3. **Halt is one transaction, and every existing refusal fires on it.** Set the standing; revoke
   every live session lease (`agent_session_lease.revoked`, `detail.cause: 'halt'`); evict every
   live presence from the hub with `halted by <human>: <reason>` and end it
   (`presence.session_ended`, `detail.cause: 'halt'`); cancel unspawned wake leases; audit
   `seat.halted` with `{reason, sponsor_scoped, leases_revoked, presences_evicted}`; deliver one
   `steer` from the human to the seat so the halt is in its inbox on resume. While halted:
   `memberStandingRefusal` answers `forbidden` "halted by <human>: <reason>" to every call; the
   claim handshake refuses with a new code `halted`; residency yields no wake candidate for the
   seat and no host is handed it. Enrollment is not revoked; resume restores wakeability with
   nothing to re-enroll.
4. **The ADR 150 gate denies a halted seat — the one case where it stops failing open.** A
   `forbidden` from `/gate` whose message starts `halted by` becomes a PreToolUse deny with that
   sentence as the reason. Every other gate failure keeps ADR 150's fail-open posture.
5. **No MCP halt tool.** Humans halt from the CLI (`musterd halt <seat> --reason`, `musterd
   resume <seat>`) and /live (a button rendered from a server-computed, viewer-relative
   `Member.can_halt`). A tool an agent could call is a tool an agent could call.
6. **The honest limit is stated on every surface.** Halt lands at the next tool boundary or
   musterd call. Mid-generation is unreachable; one long tool call has no boundary inside it. Halt
   is a bounded-window stand-down, not an emergency brake. A harness without the gate (Cursor
   today) gets the revocation and eviction, not the tool denial, and the halt output says so.

Protocol: `Member` gains `halted: {at, by, reason} | null` and `can_halt: boolean` (roster
reads); claim-handshake refusal codes gain `halted`; audit verbs `seat.halted` / `seat.resumed`
join the reference tuple; `detail.cause` is documented on the lease and presence rows.

## Consequences

- _2026-10-03, increment 1 landed (lane `01M3TAKKMMSTV14A3NVVWFCJT8`):_ two small deviations
  from Decision 1 and 3, both in the direction of the row answering alone. `halted_by` stores the
  halter's **name**, not member id — every refusal path (`memberStandingRefusal`, both claim
  handshakes, the lease-dead branch) builds "halted by <human>: <reason>" from the row with no
  second read. An unspawned wake lease is marked `expired`, not `cancelled` — the lease status
  set has no `cancelled` and every consumer already reads `expired` as "do not spawn"; the
  `seat.halted` row counts them as `wake_leases_expired`. The gate's server half (Decision 4)
  is the standing refusal on `/gate` — the hook's deny is increment 2.
- Increments, each a lane: schema + server (this lane), gate + CLI + Figma frames
  (`01M41DRSVEHVMEVY96NG5JF08S`), /live (`01M41DRWWY4EE5CGRCJMZGDNVF`), dogfood read
  (`01M41DRZTYJ2R5X41CCCT0EXF1`).
- `revokeMemberSessionLeases` gains its second caller and the first a human invokes by name.
- Lane contention shows a halted owner with a `halted` marker; a lane is not silently freed.
- Any-human halt with attribution only (izzo's recommendation in the human-surface design)
  stays open until the second-human dogfood; widening is a one-line authorizer change recorded
  here as a dated note when it happens.
- Esc-into-the-harness, halting a human, auto-expiry of a halt, and a `team_halt` tool are out
  of scope; the first needs its own ADR.

- _2026-10-03, increment 4 (lane `01M41DRZTYJ2R5X41CCCT0EXF1`), the first real halt:_ nick halted
  big-body (Codex) mid-task. Socket closed 20 ms after `seat.halted`; four leases revoked in the one
  transaction; the seat's next musterd call (56 s later) and every call after it answered 403 with
  the halter's sentence; the seat read the eviction in musterd's words and stood down. Its LOCAL
  tool calls were not denied: Codex wires no PreToolUse hook, so Decision 4's deny cannot run there
  — Decision 6's limit, observed. Write-up: `docs/wiki/halt-as-revocation.md`.

## Observability & Evaluation

**Traces.** No new trace event. Audit rows: `seat.halted`, `seat.resumed` (`held_ms`),
`agent_session_lease.revoked` and `presence.session_ended` with `detail.cause: 'halt'`, and the
gate's `halted by` deny with `detail.cause: 'halt'`. The gap between `seat.halted.ts` and the
seat's last `presence.session_ended.ts` is the measured window.

**Eval.** Dataset: server tests over one halt — every live lease revoked, every presence evicted
and ended, no wake candidate, re-claim refused `halted`, `/gate` refused `forbidden halted by`,
only a human admitted, a sponsor admitted for own agents only, re-halt refused `conflict`, resume
restoring all of it; CLI snapshots on the three frames; /live button rendered from `can_halt`
alone. Baseline: today no surface refuses on a human's stop and the only lease revocation is
credential rotate. Success: the dogfood read (lane `01M41DRZTYJ2R5X41CCCT0EXF1`) — a human halts a
seat mid-lane on revive, its next tool call is denied with the reason, `musterd resume` brings it
back and its inbox leads with the halt; the window is recorded in the wiki. Falsifier: a halted
seat completes any musterd write, is woken, or re-claims; or a run of `halted by` denies with no
matching `seat.halted`.

**Experiment.** None — a deterministic authority change. The any-human-with-attribution widening
waits on the second-human dogfood, which is where its evidence would come from.
