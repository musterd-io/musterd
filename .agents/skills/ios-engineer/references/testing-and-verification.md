# Testing and verification: prove it on a running app

A phone app fails where its developer never looked: offline, locked, at large type sizes,
on hardware the simulator does not have. Verification names which of those were checked.

## Rules

1. **Logic is tested where it is pure.** View rules, sync and the wire client are unit
   tested in Node against the package's own test runner — no native build needed, and the
   team's root test run includes them. A bug fix in that logic lands with the test that
   would have caught it.
2. **Behaviour is verified running.** Every UI or flow change: install on a simulator,
   drive the changed flow, and capture a screenshot or interaction trace (Expo MCP local
   capabilities, XcodeBuildMCP, or a mobile-automation MCP — equipment, see the core
   file). Repeatable flows worth keeping become Maestro flows (Expo's supported
   end-to-end path) rather than a one-off manual pass.
3. **The simulator cannot prove hardware.** Secure Enclave, Face ID, App Attest, push
   delivery and locked-device extension behaviour are device-only. For each, the record
   says "device-verified" with the device and build, or "unverified — needs a device"
   with the exact check owed. Simulator green is never presented as covering them.
4. **Offline and conflict are test cases, not anecdotes.** For sync changes: write while
   the server is unreachable, reconnect, and watch the queue replay; move the server's
   copy meanwhile, and watch the local write drop with its name in the sync line. Run
   both before calling a sync change done.
5. **Check the hostile inputs.** A malformed or schema-failing response renders the error
   state; a replayed or expired sealed payload is dropped before display; a failed
   signature shows the generic unverified notice with no actions. Where the team keeps a
   falsifier suite for these, it passes whole before a build ships.
6. **Accessibility is part of the run.** The changed flow at the largest Dynamic Type
   size, in dark mode, with VoiceOver over every control the change touched. Contrast and
   target sizes follow the designer role's floors; you check, they judge.
7. **Performance regressions are visible.** List scrolling, app launch and sync time on
   the changed flow, before and after where the flow is hot. A change that makes a hot
   flow slower says so in its record instead of shipping silently.

## What a verification record names

Build (id, commit), device or simulator (model, OS), flows run, screenshots kept where,
device-only checks run or owed, unit/typecheck results, and any check not run with its
reason. Attach it to the lane; acceptance reads it, not a claim that "it works".

## Sources

Expo's testing and Maestro documentation; the mobile-testing skills recorded in
`PROVENANCE.md`; this team's gates, named in `references/team.md`.
