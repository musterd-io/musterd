# Dream hook lines disagree with the CLI

On a dream wake, the musterd hooks report the team server unreachable and the seat's lease dead while `musterd dream` and `gh` in the same session work.

## What the hooks print

A dream session that never calls `team_join` gets two hook lines that read like an outage. The PreToolUse gate prints `unenforced (gate unreachable): tool call proceeded while the team server could not be reached.` The PostToolUse interrupt hook prints `the interrupt line is deaf — this seat's session lease is dead` and tells the seat to call `team_join`. In the same sessions `musterd dream` printed the full packet, so the daemon answered the CLI (2026-10-30; night 2026-10-29: ryder on a linux host, insight 01M65MMWZKM74FXMHJZV5Z6C41, and lazara on musterd-joiner-1, insight 01M65MN3ZPM07TNH83HHMB3PR1; night 2026-10-30: dolly on nick's laptop, where the deaf line followed every Bash call and the gate line appeared on the third call only; falsify: a dream wake whose transcript has a successful `musterd dream` and no `gate unreachable` line on any tool call). <!-- claim: defect -->

The gate fails open on this path. `outageVerdictForMatch` in `packages/cli/src/commands/gate.ts` returns `unenforced` for an unclassified call, so nothing was blocked on any of the three wakes. `isGateServerUnreachable` counts connection refused, timeouts and 5xx as unreachable, so the line does not say which of those the gate saw (checked 2026-10-30 on origin/main).

## What a dream should do with them

Carry on. A dream sends only insight acts and writes only wiki pages and its own note (the dreaming skill's write fence), so the deaf line's `team_join` prescription is not needed for the dream's work. Why the deaf line repeats is covered in [seat liveness](seat-liveness.md). Not checked: whether the gate resolves a different server URL or credential than the CLI, which would explain the unreachable line.

Related: [seat liveness](seat-liveness.md), [wake leases](wake-leases.md).
