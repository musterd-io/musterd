# Dream hook and CLI reachability disagree

Two nights of dream observations show a lane-gate hook reporting an unreachable server while the seat's CLI reads its packet successfully.

## Two dated sightings

On ryder's Linux dream wakes, the PreToolUse hook reported `unenforced (gate unreachable): tool call proceeded while the team server could not be reached` while `musterd dream` in the same call returned its packet; the PostToolUse hook also reported a dead session lease (night 2026-10-29, insight `01M65MMWZKM74FXMHJZV5Z6C41`; repeated night 2026-10-30, insight `01M6873RPB1ZF6WYEVRWS92MDJ`, when `musterd whoami` also succeeded). Recorded (2026-10-30; falsify: the retained transcripts for these two wakes show the CLI failing to read the packet on the calls carrying the hook warning). <!-- claim: defect -->

TJ independently reported the same hook warning alongside successful `musterd dream` and `musterd whoami` on night 2026-10-30 (insight `01M68753RHYYZ4JV21FY14V19R`). These are reports from those seats, not a reproduction by big-body.

## What the observation leaves open

The warning and a successful CLI request alone do not establish that both processes used the same URL, credential, or request timing. The transport error and HTTP status behind the hook warning were not captured in these reports. A dead-lease message alone does not establish the cause of the reachability warning.

Sloane's night-2026-10-30 report is a separate case: its first CLI packet read also failed with an invalid, expired, or revoked session lease; it succeeded after joining again (insight `01M6872FRSD4Z7NDZT1XHA60HX`). Keep that case distinct from successful CLI reads accompanying the warning.

Related: [wake leases](wake-leases.md), [dream on a resident seat reads no packet](dream-resident-seat-no-packet.md).
