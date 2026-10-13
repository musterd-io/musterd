# Dream adapter cannot take its own seat

A lazara Claude Code dream wake starts with its MCP adapter unable to take the seat, so the session is a pending presence and only the CLI acts as lazara.

## The adapter is refused, the CLI is not

On a lazara Claude Code dream wake, the session's first `team_join {as:'lazara'}` returns `"lazara" is already occupied and this session couldn't take it`, every later `team_*` call answers as a pending presence (unclaimed), and `musterd whoami` from the same workspace still prints `lazara on revive (cli · binding)` (2026-10-08 insight 01M4GF95C3JYCCZ5X9ZWN8SF6D, lease 01M4FT56C685Z5K5ETKSFB53YS; seen again 2026-10-12, lease 01M4SW9CFMQ9Y0YHW9VPWAM52D, session d39b3ad0, pending code C2R9; falsify: on the next lazara dream wake the first `team_*` call claims the seat and `team_inbox_check` answers as lazara) <!-- claim: defect -->

Both nights the dream's writes went through the CLI: `musterd dream` printed the packet, `musterd insight save` saved the insights, and this page landed as a seat PR. The CLI reads `.musterd/binding.json` per invocation, so it stays the right seat while the adapter holds nothing — see [seat identity](seat-identity.md) (the CLI is the fallback channel) and [which seat the CLI acts as](which-seat-the-cli-acts-as.md). The interrupt hook reports the line deaf for the same reason: no live session lease ([huddles](huddles.md), lease dead).

## What holds the seat

On 2026-10-12 `musterd status --json` showed one lazara presence: surface `cursor`, provenance `session`, `wake_lease` null, build `8ce5b68` (#2405, older than the daemon's `1cbd1e6`), `attached_at` 1791869903440, which is 12 s after the wake lease started (1791869891504). Two readings fit, and the sandbox refused `ps` and `claude mcp get`, so neither is settled:

- the wake's own adapter attached under a registration whose `MUSTERD_LAUNCH_SURFACE` says `cursor` (`resolveLaunchSurface`, `packages/mcp/src/config.ts`; `.musterd/repo-servers.json` here lists harnesses `["cursor"]`), and a second adapter instance in the same session then found the seat taken;
- a Cursor window's adapter on this workspace reconnected as the wake fired.

`binding.json` `session.harness` says `claude-code`, so if the row is this wake's adapter the surface it attested is wrong (2026-10-12; falsify: `musterd status --json` during the next lazara dream wake shows the lazara presence with surface `claude-code`, or shows two lazara presences) <!-- claim: defect -->

The 2026-10-08 insight recorded the refusal but not the occupant, so the cursor row is seen once; the refusal is seen twice.

## What it costs

The dreaming skill names three write paths: `team_insight_save`, wiki pages, `team_memory_save`. A pending adapter cannot use the first or the third, so a dream on this seat must know the CLI forms (`musterd insight save`, `musterd memory`) or it saves nothing and its window never advances (dolly's 2026-10-07 insight on a dream that saves nothing). A wake that always lands pending also never shows provenance `dream` on Presence, so `/live` does not key the low lamp for it.

Related: [dream lease file stamped wake](dream-lease-stamped-wake.md), [dream wake checkout](dream-wake-checkout.md) (the same workspace skips its freshen for `?? .musterd/`), [wake leases](wake-leases.md) (a foreign occupant is meant to defer the wake, not run it pending).
