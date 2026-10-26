# 738 — `musterd status` shows the hub link: last good sync, or the failure and its cause

- Status: accepted
- Date: 2026-10-26

## Context

A joiner pulls from its hub every minute (`SYNC_PULL_INTERVAL_MS`) and pushes on its own loop. A
failed tick is logged (`sync_pull_failed`, `sync_push_failed`) and retried. Nothing records it. ADR
598 classified a hub failure (errno class, and Tailscale's state when the hub is on a tailnet) and put
that cause on a refused claim, handoff or submit, and only there.

`musterd status` reads the roster's `sync` object, which already says when this machine's push is
wedged (ADR 360), when its fold is stopped (ADR 547) and when the hub's fold is stopped (ADR 591).

## Problem

A person on a joiner cannot tell from `status` whether the hub is reachable. When it is not, the first
sign is a refused claim. Until then the roster shows the last state this machine folded, and it looks
current. When the hub is reachable, nothing says how fresh the folded state is. The cause is known to
the daemon on every failed pull. It is logged and then forgotten.

## Decision

1. **The joiner's pull records the hub link.** Around the page fetch (`fetchPageNoting` in
   `packages/server/src/sync/pull.ts`): a pull the hub answered records `last_ok_at`; a pull that
   failed records the failure with the ADR 598 diagnosis (`diagnoseHubFailure`), keeps `last_ok_at`,
   and keeps `failing_since` from the first failure of the run. No new probe: the record is what the
   existing pulls found. It is in memory per daemon config (`packages/server/src/sync/hubLink.ts`), as
   the hub stop is (ADR 591), and a restart relearns it on the first pull.
2. **The roster carries it.** `sync.hub_link` (`HubLink` in `@musterd/protocol`): the hub's host, never
   a credential; `last_ok_at`; `failing_since`; and `failure` (`kind`, `code`, `tailscale`). Additive. It is null on the hub and on a machine without one, and an older daemon omits it.
3. **`status` prints one line from it**, worded once by `describeHubLink` in the protocol package:
   - up: `hub 100.100.246.14:4849 — last sync 2m ago` (meta colour);
   - not yet pulled: `hub … — no sync yet since this daemon started`;
   - failing: `⚠ hub 100.100.246.14:4849 unreachable since 9m ago — Tailscale is stopped on this
     machine — start it (\`tailscale up\`); last sync 1h ago` (warning colour). The cause is
     Tailscale first when it is stopped or absent on a tailnet hub, then the errno class.

## Consequences

- A joiner's `status` says how fresh its view is and, when the hub is unreachable, since when and why,
  before any write is refused.
- Only the pull is recorded. A push that fails while pulls succeed is the ADR 360 wedge's ground, and a
  network failure hits both loops alike.
- The line is additive output after the roster, like the ADR 360, 547 and 591 lines, which also have
  no terminal frame. `--json` is unchanged: it prints the members only.
- After a restart the line reads "no sync yet" for up to one pull interval.

## Observability & Evaluation

- **Traces:** none new. The failures are already logged as `sync_pull_failed`; this keeps the latest
  one for the roster.
- **Eval:** `packages/server/src/sync/hubLink.test.ts` covers a good pull, a run of failures keeping
  the last sync and the first failure, the Tailscale cause on a tailnet hub, recovery clearing the
  failure, and isolation per config and team. `packages/protocol/src/nodes.test.ts` covers every
  wording of `describeHubLink`, and that the hub field cannot carry control characters.
- **Experiment:** n/a. The falsifier on the live team: a joiner whose hub is unreachable for more
  than two pull intervals, whose `musterd status` does not print the `⚠ hub … unreachable` line.
