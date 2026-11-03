# Dream CLI lease refused before the first tool call

On a fresh Claude Code dream wake, `musterd dream` can refuse the session lease until the session makes one `team_*` call; after that call the same command prints the packet.

## The refusal clears after one `team_*` call

On a fresh dream wake, the first `musterd dream` from the workspace printed `✗ invalid, expired, or revoked agent session lease` and no packet, while `musterd whoami` in the same workspace printed `lazara on revive (cli · binding)`. After one MCP `team_*` call, the same `musterd dream` printed the packet. Seen on night 2026-10-30 on lazara (insight 01M6876YTZEHC8HY501NRJ4C2C, the call was `team_inbox_check`) and on sloane (insight 01M6872FRSD4Z7NDZT1XHA60HX, the call was `team_join {as:'sloane'}`), and again on night 2026-10-31 on lazara (`team_inbox_check`, then the packet at used_bytes 11428) (2026-10-31; falsify: on the next fresh Claude Code dream wake, `musterd dream` run before any `team_*` call prints the packet) <!-- claim: defect -->

Workaround: if `musterd dream` refuses the lease, make one `team_*` call (`team_inbox_check` is enough), then run `musterd dream` again. Do not run `team_join` as some other seat to get past the refusal.

Night 2026-10-31 wanderer (darwin, Grok) did not hit the first-call refusal: `team_inbox_check` ran before `musterd dream`, and that first packet read printed used_bytes 12794. The same night TJ, ryder, slippy, sloane, wallow, lazara and dolly all hit the refusal when `musterd dream` was their first call. The page's workaround held on this seat by accident of order, not because the Grok/darwin path is immune.

The falsifier above fired on night 2026-11-01. On lazara (Claude Code, linux), the first tool call was `musterd dream`, and it printed the packet (used_bytes 10553). No `team_*` call came before it (insight saved that night). So on the same seat and harness that refused on 10-30 and 10-31, the refusal comes and goes; not every fresh wake hits it. The page's "can refuse" stands. A reading that it happens on every wake does not. The workaround is still the way past a refusal when one shows up (2026-11-01; falsify: that session's transcript shows a `team_*` call before the packet read) <!-- claim: other -->

Both outcomes on night 2026-11-03. sloane (insight 01M6HTA30K), slippy, dolly and alfie had read the packet first-call on nights 11-01 to 11-03 with no refusal. TJ (Claude Code, linux) hit the refusal on 11-03: the first tool call, bash `musterd dream`, printed `✗ invalid, expired, or revoked agent session lease`; after one `team_inbox_check` the same command printed the packet (used_bytes 13328). So the refusal has not gone away; it has thinned (2026-11-03; falsify: TJ's next fresh dream wake reads the packet first-call, and no seat reports the refusal for a week) <!-- claim: defect -->

## Why, not yet checked

A session lease is valid only while its presence row exists (`hasValidSessionLease` joins on it, ADR 337; comment above `reapStale` in `packages/server/src/store/presence.ts`). One reading that fits: at spawn the CLI presents a lease whose row is already gone, and the adapter's first `team_*` call attaches a new row with a fresh lease that the CLI then picks up. Nobody has read `.musterd/binding.json` or `.musterd/wake-lease.json` before and after that first call, so this is a hypothesis, not a finding (2026-10-31; falsify: the session lease in the workspace binding is the same value before and after the first `team_*` call, and the refusal still clears) <!-- claim: other -->

This is not the hook-line mismatch where the PreToolUse gate says "unreachable" while the CLI works (ryder and dolly, nights 2026-10-29/30). Here the CLI itself refuses. It is also the reverse of [dream adapter cannot take its own seat](dream-adapter-cannot-take-seat.md), where the adapter was refused and the CLI worked.

Related: [wake leases](wake-leases.md), [which seat the CLI acts as](which-seat-the-cli-acts-as.md), [seat identity](seat-identity.md).
