# 554 — A wake that runs inside the host holds a lease marked `in_process`

- Status: accepted
- Date: 2026-10-08
- Deciders: nick ("yes add as its own adr", 2026-10-08), dolly (lane `01M4FBXYY06FNQQT57J816Y2WE`)
- Lane: `01M4FBXYY06FNQQT57J816Y2WE` (goal `wake-take-over`); the field itself landed in lane
  `01M4ECTZ84NRQMBQQXPQX64RF5` (wake watch 6/6, PR #2240)
- Relates to: ADR 546 (wake take-over — this ADR was first a dated note in its Consequences), ADR 354
  (the wake-lease file), ADR 236 (attestation needs a source), ADR 131 §5 (nothing local crosses to
  the daemon)

## Context

ADR 546 made a wake findable, stoppable and watchable by writing a `wake-lease.json` that names the
wake's session. Every child-process backend (Claude Code, Codex, Grok, opencode) holds one through
`holdWakeLease`, and each lease's `spawner_pid` is the harness child the host spawned.

The native loop is not a child. It runs inside the host process, so the only pid it can name is the
host's own. That breaks two things the lease file's readers assume:

- `stopWake` (`packages/cli/src/launcher/yield.ts`) ends a stuck wake by signalling `-spawner_pid`, the
  harness's process group. On a native lease that is the host's group: the signal stops the daemon.
- The MCP adapter (`packages/mcp/src/wakeLeaseFile.ts`) honours a lease when `spawner_pid` is in its
  own ancestry, which is what makes the lease an attestation and not a default (ADR 236). Every child
  of the host in that folder has the host's pid in its ancestry, so any of them could attest a lease
  it was never given.

ADR 546 first recorded the native loop as "no lease at all" for exactly this reason. Lane 6/6 then
needed a lease, so a take-over and a watch could find a native wake. The field that makes that safe
is `WakeLeaseFile.in_process` in `@musterd/protocol`. The protocol rule says a schema change needs an
ADR; ADR 546 carried it as a Consequences note, which does not meet that rule.

## Problem

How does a lease name a wake that has no child process, without a launcher signalling the host or an
unrelated process attesting through the lease?

## Decision

1. `WakeLeaseFileSchema` gains an optional `in_process: boolean`. When `true`, the wake is a loop
   inside the host, and `spawner_pid` is the host's own pid. Absent or `false` is every existing
   lease, unchanged.
2. **A launcher never signals an `in_process` lease.** `stopWake` writes the yield marker
   (`wake-yield.json`) and waits up to 10 s for the lease file to clear. The loop polls the marker
   every 500 ms and ends at a tool boundary: at once when no tool is running, else when the running
   one returns. Past the wait, `stopWake` answers `stuck` and the launcher refuses to open a second
   session beside a running loop. There is no `SIGTERM` or `SIGKILL` step.
3. **The MCP adapter never honours an `in_process` lease.** `readWakeLease` returns no attestation
   for it, whatever the ancestry says.
4. **The lease names no conversation to resume.** A native wake has no `session_id`; take-over on it
   stops the loop and opens a fresh session. Resume-by-replay from the `wake-turn` capture rows is
   not built.
5. The field never leaves the machine (ADR 131 §5). It is not in `WakeReportBodySchema` or any wire
   shape.

## Consequences

- `SPEC.md` is unchanged: the wake-lease file is a local file, not part of the protocol on the wire.
  `docs/architecture/02-protocol.md` records the field and now cites this ADR.
- A new in-process backend sets `in_process: true` and gets items 2 and 3 for free. A new
  child-process backend sets nothing.
- A reader built before this field would strip it and treat a native lease as a child's. In this repo the launcher and the adapter ship together and read the field; any other
  reader of `wake-lease.json` must check `in_process` before it signals or attests. Falsifier: a
  launcher or adapter that signals or honours a lease whose file says `in_process: true`.
- ADR 546's Consequences note for lane 6/6 stays as the record of what that lane did; this ADR owns
  the field's decision from here.
- Alternatives considered: (a) **No lease for the native loop** (ADR 546's first position). Rejected:
  a take-over and a watch cannot find a wake without one. (b) **Name a synthetic pid.** Rejected: any
  pid is signalable or in someone's ancestry, so the launcher check would need the same flag anyway,
  hidden behind a lie. (c) **A second file for in-process wakes.** Rejected: every reader already
  looks at `wake-lease.json`; one extra optional field is cheaper than a second place to look.

## Observability & Evaluation

n/a — a local lease field with no agent-facing behaviour. The unit tests for `stopWake` (in-process
branch, no signal sent) and `readWakeLease` (in-process lease returns no attestation) pin items 2 and
3. Falsifier: either test removed or passing with a signal sent.
