# 489 — A CLI wait is not a reload: same-workspace reap needs the same surface; --wait wakes on replies to my acts

- Status: accepted
- Date: 2026-09-30
- Deciders: izzo (lane 01M3TEY06P; nick directed the lane)
- Relates to: ADR 092 (durability-gated same-workspace eviction), ADR 068 (same-workspace claims do
  not supersede), ADR 054 (`inbox --wait`), ADR 075 (a live CLI wait is a WS claim), ADR 337 (the
  session lease is bound to a Presence)

## Context

`musterd inbox --wait` blocks on the watch socket until a directed act arrives. Since ADR 075 that
socket is a claim of the seat's own Presence. Agents use it to wait for an acceptor after
`lane_submit`, usually from the same workspace as their live harness adapter.

On 2026-09-30 izzo ran it twice from its own workspace. Both times Claude Code's musterd MCP server
disconnected about ten seconds after the wait connected, and the seat was deaf until `/mcp`
reconnected it. The daemon log for the second run: the wait's `ws_claim_occupied` (conn `01M3TEDP9K`)
at `1790815164735`, `claim.duplicate_workspace {grace_ms: 10000}`, then the adapter's `ws_close`
(conn `01M3TDCXTX`) at `1790815174757`. dolly recorded the deafness 2 of 2 on 2026-09-22
(`docs/wiki/authorised-but-unowned.md`), so this is 4 of 4.

The same wait printed "no directed act within 300s", but sloane's acceptance verdict
(`01M3TEFDSH`) landed 57 s into the window. It was sent to `@team`, with `in_reply_to` naming izzo's
acceptance ask. Over the 7 days to 2026-09-30, 130 of 240 accept/decline acts that carry
`in_reply_to` were sent to `@team`.

## Problem

1. ADR 092 reads "same workspace" as "same session, reloaded". After its grace, a durable
   same-workspace successor reaps every same-workspace predecessor. A CLI wait in an adapter's
   workspace is not a reload. It is a second reader of the same seat. Reaping the adapter for it
   closes the adapter's socket and clears the Presence its session lease is bound to (ADR 337), so
   the seat goes deaf and the harness drops the server.
2. `--wait` wakes only on acts addressed to the seat by name. More than half of the verdicts it is
   used to wait for are sent to `@team`, so it sleeps through them.

## Decision

1. **A reload keeps its surface.** The ADR 092 grace-gated reap applies only when the successor
   declares the same surface as the predecessor (`isReloadOf`, `packages/server/src/transport/hub.ts`).
   A same-workspace successor with a different surface coexists with the predecessor. It is neither
   reaped later nor displaced now. A predecessor with no recorded surface keeps the ADR 092
   behaviour. This applies on the WS claim path and on the admin-approve path for a pending claim.
   The HTTP claim path already spares same-workspace sessions and does not change.
2. **A reply to my act is directed at me.** `--wait` also wakes on an act of any address whose
   `meta.in_reply_to` names an act this seat sent. `--from` / `--act` still narrow it, and the
   seat's own sends never wake it. The CLI reads the referenced act back from the team timeline at
   the timestamp its ULID carries, because the inbox never returns a seat's own sends.

## Consequences

- A seat can wait for its acceptor from its own workspace without losing its adapter. The waiting
  idiom in the wiki works again, and an agent no longer needs a human to run `/mcp`.
- A seat can briefly hold two live connections from one workspace on different surfaces: the
  adapter and a CLI wait or watch. Delivery already fans out to every connection of a member. The
  roster still shows one Member.
- Two adapters of the same surface in one folder (the issue #118 reload war that ADR 092 fixed) are
  still reaped after the grace.
- A reply check costs one `GET /messages` per distinct `in_reply_to` the wait sees. Each result is
  cached for the wait's lifetime. It runs only for acts not addressed to the seat by name.
- The surface is a declared string. A client that declares the adapter's surface from a CLI still
  reaps the adapter after the grace, as before.

## Observability & Evaluation

- **Traces:** none added. The fix is visible in what is already audited: `claim.duplicate_workspace`
  and a later `claim.superseded {same_workspace: true}` no longer appear for a CLI wait in an
  adapter's workspace. `interrupt_probe_refused lease=dead` should stop following a wait.
- **Eval:** dataset is `~/.musterd/daemon.log` and the audit table. Baseline on 2026-09-30: 4 of 4
  waits from an adapter's workspace were followed by an adapter `ws_close` about 10 s after the
  wait's claim, with a `claim.superseded` audit row. Falsifier: after this ships to the daemon, run
  `musterd inbox --wait --timeout 60` from a seat workspace whose adapter is live. Then a
  `claim.superseded` row for that seat in the window, or the deaf line from
  `musterd inbox --interrupt-check`, means Decision 1 does not hold. For Decision 2: send an `@team`
  `accept` with `in_reply_to` set to the waiting seat's act; the wait must exit 0. The CLI test
  `cli.e2e.test.ts` › "wakes on an @team reply whose in_reply_to names an act this seat sent" pins it.
- **Experiment:** n/a — a defect fix with a direct before/after, not a design choice between
  alternatives.
