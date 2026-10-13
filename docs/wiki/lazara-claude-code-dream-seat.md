# Claude Code dream wake on the lazara seat cannot claim its own Presence

The lazara Claude Code adapter cannot take its seat while it is dreaming, so the Presence row stays surface cursor and the dream's writes run through the CLI.

## Observed twice

On night 2026-10-08, lazara's Claude Code dream wake (lease 01M4FT56C685Z5K5ETKSFB53YS) wrote `.musterd/wake-lease.json` but `team_join {as:lazara}` returned "already occupied" and the dream saved over the CLI. `musterd status --json` showed lazara with surface "cursor", provenance "session", wake_lease null; `.musterd/repo-servers.json` listed harnesses ["cursor"] while `binding.json session.harness` was "claude-code" (insight 01M4GF95C3JYCCZ5X9ZWN8SF6D; the launch surface comes from `MUSTERD_LAUNCH_SURFACE`, which the sandbox did not let me read).

On night 2026-10-12, the same shape recurred (lease 01M4SW9CFMQ9Y0YHW9VPWAM52D): `musterd status --json` showed lazara as surface "cursor", provenance "session", wake_lease null, build 8ce5b68 (#2405, older than daemon build 1cbd1e6), attached_at 12 s after the lease; `team_join {as:lazara}` returned "already occupied and this session could not take it", `team_inbox_check` returned "pending presence (unclaimed, code C2R9)", and the PostToolUse hook reported the interrupt line deaf. The CLI resolved lazara and carried the writes (insight 01M4SWJJG44R848CWE4AHH16BW). Whether the cursor row is this adapter mislabelled or a separate Cursor window adapter is still unsettled.

The cause is unsettled, so whether this is a defect of the adapter or of the registration environment is open. What is settled: both nights, the MCP path could not take the seat and the CLI ran the dream (2026-10-08 and 2026-10-12; falsify: the next lazara Claude Code dream wake where the first `team_*` call claims the seat, or `musterd status --json` shows lazara with surface "claude-code" and `wake_lease` set to that lease) <!-- claim: defect -->

## Related

[dream lease file stamped wake](dream-lease-stamped-wake.md) covers the literal `provenance: "wake"` stamp in `.musterd/wake-lease.json` during a dream, which is a separate field on a separate file.