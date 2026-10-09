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
- 2026-10-08 (lane `01M4ECTJH025RJEFC0VJPDNPE1`): every child-process wake backend now holds a lease
  file with its session id through one helper (`holdWakeLease`), so Codex, Grok and opencode wakes are
  findable by `musterd <seat>`. The native loop deliberately writes none: it runs inside the host, so
  the only pid to name is the host's, and a launcher that signals a lease's pid as a process group
  would stop the host. Native take-over waits for an in-process stop.
- 2026-10-08 (lane `01M4ECTZ84NRQMBQQXPQX64RF5`, wake watch 6/6; the `in_process` field is decided in
  ADR 554): the native loop is now findable,
  stoppable and watchable, in process. `WakeLeaseFile.in_process` (optional) marks a lease whose
  `spawner_pid` is the host's own: a launcher never signals it, and the MCP adapter never honours it
  (the host's children would otherwise match its pid). The loop polls the yield marker every 500 ms and
  stops at a tool boundary — at once when no tool is running, else when the running one returns — so a
  native wake gets the same guarantee a hooked harness gets from `musterd gate`. `stopWake` on an
  `in_process` lease writes the marker and waits up to 10 s for the lease file to clear; past that it
  answers `stuck`, and the launcher refuses rather than open a second session beside a running loop.
  Watch reads `wake-watch.jsonl`, a local spool the host writes beside the lease (words and tool calls
  only, credentials scrubbed, 256 KiB cap, mode 0600, named by lease id, left in place for the
  watcher's final read and replaced by the next wake). **Take over on a native wake stops it and opens a
  FRESH session; it does not resume**, because native has no harness conversation to `--resume`.
  Resume-by-replay from the `wake-turn` capture rows is native phase 2 and is not built.
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
