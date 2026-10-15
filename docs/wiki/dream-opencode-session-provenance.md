# OpenCode dream wakes attach as session

An OpenCode dream wake attaches its Presence with `provenance: "session"` and `wake_lease: null`, because the MCP adapter runs under the persistent `opencode.exe serve --service` daemon rather than the `opencode run` wake child.

## The observation

During an OpenCode dream wake, `musterd status --json` shows the seat's `surface: "opencode"` Presence row with `provenance: "session"` and `wake_lease: null`, while same-night `surface: "grok"` dream wakes (`grokbot`, `wanderer`) settle to `provenance: "dream"` (2026-10-12 dreamy `attached_at` 1791869998172, insight 01M4SWJS7P761NZGD23JGRQDV7; seen again 2026-10-14 dreamy lease 01M4Z1F2BYV6YNC9D6R2928282, `attached_at` 1792043203821, and ghost lease 01M4Z0P4WAD21J5VH4VSD55TH1, `attached_at` 1792042476323; falsify: `musterd status --json` during an OpenCode dream wake on `dreamy` or `ghost` shows `presences[].provenance` equal to `"dream"` and a non-null `wake_lease`) <!-- claim: defect -->

## Why the adapter never sees the lease

On 2026-10-14 (`dreamy`, lease `01M4Z1F2BYV6YNC9D6R2928282`, started 1792043122423, session `ses_ec1e80092ffej09a2LYMYUUgdk`), the process tree inside the wake showed:

- `opencode run --format json` ran as PID `35892` (PPID `1`, started 22:45:22 PDT) with `MUSTERD_PROVENANCE=wake` and `MUSTERD_WAKE_LEASE=01M4Z1F2BYV6YNC9D6R2928282` in its environment, and `.musterd/wake-lease.json` recorded `spawner_pid: 35892`.
- `opencode run` delegated the session to the long-lived `opencode.exe serve --service` background daemon (PID `79436`, PPID `1`, started 16:42:35 PDT).
- The MCP adapter (`/Users/swethadhamodharan/.musterd/runtime/packages/mcp/dist/index.js`, PID `18783`, PPID `79436`, started 22:05:23 PDT) is a child of `opencode.exe serve --service`, not of `opencode run`.

Both lease-delivery paths in `loadMcpConfig` (`packages/mcp/src/config.ts`) miss that adapter:

1. The adapter process was spawned by `opencode.exe serve --service` forty minutes before the dream wake began, so its environment carries neither `MUSTERD_PROVENANCE` nor `MUSTERD_WAKE_LEASE`, and `loadMcpConfig` runs only once at adapter boot.
2. Even at boot, the [ADR 354](../decisions/354-wake-lease-file-channel.md) file fallback (`readWakeLeaseFile` in `packages/mcp/src/wakeLeaseFile.ts`) requires `deps.ancestors().includes(lease.spawner_pid)`, and the `opencode run` PID (`35892`) is a sibling under `launchd` (PID `1`), not an ancestor of `opencode.exe serve --service`'s child (`18783` → `79436` → `1`).

When the dream calls `team_join`, the adapter claims the seat with `provenance: "session"` and `wake_lease: null`, and `opencodeBackend` (`packages/cli/src/host/backends/opencode.ts`) credits the unattested row via `own_unattested` ([ADR 379](../decisions/379-the-actuator-spares-the-child-it-can-identify-as-its-own.md)).

## What it costs

Because the live socket Presence row on an OpenCode dream carries `provenance: "session"` instead of `"dream"`, `isDreaming` (`packages/server/src/store/dream.ts`) returns `false` and `senderProvenance` (`packages/server/src/store/messages.ts`) stamps insights saved during the dream with `from_provenance = 'session'` — so `lastDreamAt` (`WHERE from_provenance = 'dream'`) returns `null` and `musterd dream` falls back to the 24-hour `default_since_ms` window (2026-10-14 `until - since = 86_400_000` on both `dreamy` 1791956743063..1792043143063 and `ghost` 1791956127670..1792042371757; falsify: `musterd dream` on `dreamy` or `ghost` after a night that saved an insight via `team_insight_save` returns `until - since` different from `86400000`, or the saved insight's `messages.from_provenance` column reads `'dream'`) <!-- claim: defect -->

Related: [dream adapter cannot take its own seat](dream-adapter-cannot-take-seat.md), [dream lease file stamped wake](dream-lease-stamped-wake.md), [wake leases](wake-leases.md), [ADR 494](../decisions/494-when-a-seat-dreams.md).
