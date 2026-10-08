# 546 — Wake take-over: a person takes over a wake's conversation, or watches it live

- Status: accepted
- Date: 2026-10-08
- Deciders: nick (approved the spec 2026-10-07), dolly (lane `01M4C6VGFH9G9XC3Q9D5SPET2H`)
- Relates to: ADR 543 (the launcher names a wake), ADR 491 Decision 6 (a live seat is launched again
  only after a warning), ADR 092 (a same-workspace successor ends its predecessor), ADR 354 (the
  wake-lease file), ADR 241 (the wake lease), ADR 131 §5 (nothing local crosses to the daemon)
- Spec: `docs/superpowers/specs/2026-10-07-wake-take-over-design.md`

## Context

On 2026-10-07 nick ran `musterd dolly` while a headless wake held the seat. ADR 543 made the prompt
say so. The answer was still a trade nobody wanted: `y` replaces the wake and cuts its work off, and
`N` leaves the person without the seat. What the person wanted was to continue the wake's
conversation, or to see what it was doing, without two sessions in one folder.

Three things stood in the way:

- The launcher cannot find the wake's conversation. Claude Code wakes write no `wake-lease.json`
  today; only `host/backends/codex.ts` does (ADR 354). The host mints the session id and passes it
  to `claude`, but never records it where the launcher can read it.
- There is no way to ask a headless run to stop. Its harness runs until it ends, and ADR 092's
  replacement kills it mid-tool.
- The wake report lands at verification, long before a take-over. A take-over has no wire shape,
  so the daemon would count a stopped wake as a failure.

## Problem

How does a person on the machine that runs a wake stop it cleanly, resume its conversation, and have
the team record that as a hand-over rather than a failed wake, without sending the daemon a session
id or a transcript path?

## Decision

1. **The lease file carries `session_id`.** `WakeLeaseFile.session_id` is optional. Claude Code wakes
   now write `wake-lease.json` after spawn, as Codex wakes do, and clear it when the run settles.
   The id never leaves the machine (ADR 131 §5). An older host writes none, and take over then falls
   back to ADR 543's question.
2. **A yield marker asks a wake to stop.** `WAKE_YIELD_FILE` (`wake-yield.json`) holds
   `{ lease_id, by, at }`. The host consumes it when the run settles, but only when it names that
   run's lease. A marker left for another lease is left alone, so it can never stop a later wake.
3. **`yielded` rides the supplementary wake report.** `WakeReportBody.yielded` is optional. The
   server records it on the `residency.wake_cost` row and does not touch the primary outcome, so a
   take-over is never a failed wake and re-fires no lane. A report with `yielded` and no cost is a
   supplement, not a duplicate primary.
4. **The user-facing flow** (landed in increments 2–4):
   - `musterd <seat>` on a wake it can find offers `⏎ take over · w watch · esc`.
   - Take over writes the yield marker. `musterd gate` denies the wake's next tool call.
   - A wake in a long model turn makes no tool call, so after 10 s the launcher stops its process
     group.
   - The launcher then resumes the wake's own conversation (`--resume <session_id>`).
   - Watch follows the wake's transcript read-only.
   This amends ADR 491 Decision 6 and ADR 543 for a wake on this machine. A session a person opened
   keeps today's question.

This ADR's increment lands items 1–3 (the wire and the host). Items in 4 are specified by the spec and
land in increments 2–4.

## Consequences

- Take-over is recorded as `residency.wake_cost` with `yielded: true`. Counting those rows counts
  take-overs.
- Claude Code wakes now write a lease file. The adapter already honours that file only when its
  parent pid is `spawner_pid` and the file is unexpired (ADR 354), so a person's session opened in
  the same folder is unaffected. The file now also names a conversation id, mode `0600`, in a
  gitignored folder.
- The file has to be treated as untrusted by its readers: a stale file (crashed host, expired lease,
  reused pid) must read as "no wake here". The launcher check lands in increment 3.
- Alternatives considered: (a) **Kill the wake with a signal at once.** Rejected: it cuts a tool call
  in half and can leave a lane claim or a half-written file. The tool boundary is the safe stop.
  (b) **Send the session id to the daemon so any machine can take over.** Rejected: ADR 131 §5 keeps
  session ids and paths local, and a wake is tied to the machine that holds the transcript.
  (c) **A new report instead of a field on the supplementary one.** Rejected: the supplementary
  report already exists for facts that only exist at run exit, and a second route buys nothing.

## Observability & Evaluation

n/a — a human-facing launcher flow and a host-side lease file. It changes no agent-facing behaviour:
the deny line a taken-over wake sees only asks it to end its turn. `residency.wake_cost` rows with
`yielded: true` count take-overs (query the audit log), and the unit tests pin the three wire
changes.
