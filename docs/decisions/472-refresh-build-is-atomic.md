# 472 — A failed refresh build rolls the daemon's checkout back, and web leaves the daemon build

- Status: accepted — 2026-09-28
- Date: 2026-09-28
- Lane: `01M3N7FVPYHE8KQKMDRK3DRJN4` (incident, goal `launch`)
- Amends: [ADR 118](118-service-refresh.md) (what `service refresh` does when its build fails, and
  what it builds).

## Context

`service refresh` and the auto-refresh tick sync the daemon's checkout (`~/.musterd/runtime`) to
`origin/main`, run `pnpm --dir <checkout> build`, and restart the daemon if the build passed
(ADR 118). The same checkout also holds the `dist` that every seat's `musterd` CLI, every harness
hook, and every seat's musterd MCP server run from. The daemon is one consumer of that checkout,
and not the only one.

`pnpm -r build` builds packages in dependency order and writes each package's `dist` in place.

On 2026-09-28 three refreshes in a row failed their build (13:42 → `f06870f`, 13:57 → `7d46d08`,
14:51 → `66ed2df`). Each failure was in `@musterd/web`: the static prerender errored on a route,
retried, and dropped it (`/live` 8 times, `/character-sheet` 4, `/broadcast` 2), and
`check-prerendered-routes` failed the build as it is meant to. The 13:57 run logged
`building…` and then nothing more; the tick exited 1 with no result line.

The 14:51 failure is the one that mattered. By the time web failed, `protocol` and `server` had
already been rebuilt at `66ed2df`. `cli`, `mcp` and `web` were still at `0a5012c`. `66ed2df`
(#1798, ADR 468) removed `capitalizeSeat` from `@musterd/protocol`, and the old `cli` imported it,
so every `musterd` invocation on the machine died with a `SyntaxError` at import. The harness hooks
wrap `musterd` in `2>/dev/null || true`, so the lane gate (ADR 150), the trace taps (ADR 445),
session capture, and the orient and interrupt nudges all went dead without a sound. The refresh
reported `build failed — the daemon is still running the previous code (not bounced)`. That was
true of the daemon process, which had loaded `0a5012c` into memory. It was false of the checkout
everything else runs from. izzo found it about an hour later, and repaired it by rebuilding `cli`
and `mcp` in the runtime at `66ed2df`.

## Problem

1. A failed build leaves the shared checkout's packages built from two commits. Nothing detects
   this, and the failure message says the opposite.
2. The daemon build includes `@musterd/web`, whose output the daemon never serves. `/live` is
   served from the separately published bundle under `~/.musterd/live/web` (ADR 132), which the
   `/live` publisher builds in its own checkout. The web prerender is the build's flakiest step
   under load, so a page that nobody reads from this checkout decides whether the CLI, server and
   MCP get updated.

## Decision

1. **The daemon build is every package except `@musterd/web`:**
   `pnpm --dir <checkout> -r --filter '!@musterd/web' build` (`DAEMON_BUILD_ARGS`). Web keeps its
   own build and gates in CI and in the `/live` publisher. The daemon checkout's `web/dist` is left
   as it is, and nothing reads it.
2. **A failed build rolls the checkout back.** `refreshDaemon` switches the checkout back to the
   commit it was on before the refresh, runs the install check (the failed hop may have installed
   a lockfile the old commit does not match), and rebuilds that commit with the same arguments.
   Every package then carries one commit again. The daemon is not bounced, as before.
3. **The failure message says which of two outcomes happened.** If the rollback build passed: `build
   failed at <new> — rolled back to <old> and rebuilt it`. If it failed too: `rebuilding <old>
   failed too — <checkout> may hold dist from both commits, so musterd and the hooks may not
   start`, with the command to rebuild by hand. Both throw, so the auto-refresh tick's existing
   notify, block and `.attempted-sha` handling is unchanged.

## Consequences

- The class of outage above needs two builds to fail back to back, and says so loudly when they
  do. A single failed refresh leaves every consumer of the checkout on the previous commit.
- A failed refresh now costs two builds instead of one. It happens a few times a week at most, on
  a path that already takes minutes.
- A web-only merge still triggers a refresh (the tip moved), which now rebuilds the other packages
  and restarts the daemon without building web. That is the same restart as before, minus the
  step that could fail it.
- Web breakage no longer surfaces through the auto-refresh's operator notice. CI's `gates` and the
  `/live` publisher's build log (`~/.musterd/live/build.log`) remain its homes.
- Not addressed here: why the 13:57 tick died after `building…` without a result line, and why the
  prerender is flaky under load. Both are real. Neither can split the checkout any more.

## Observability & Evaluation

**Traces** — n/a: a lifecycle command, not a runtime path. The refresh log
(`~/.musterd/autorefresh/refresh.log`) carries the new messages verbatim, so a rollback is visible
there without reading dist stamps.

**Eval** — the metric is **split-checkout incidents**: a time when the daemon checkout's packages
carry `dist/build.json` (ADR 135) stamps from more than one commit. *Dataset:* the stamps of
`protocol`, `server`, `cli` and `mcp` under `~/.musterd/runtime/packages/*/dist/build.json`, read
after every refresh failure in the refresh log. *Baseline:* 1 incident on 2026-09-28 (`protocol`
and `server` at `66ed2df`, `cli` and `mcp` at `0a5012c`), out of 3 failed refreshes that day.
*Target:* 0 from a single failed build. Falsifier: a refresh whose build fails leaves those stamps
on two commits.

**Experiment** — before/after is the same failing refresh. Before: the build fails late and the
checkout is left split, which `service.test.ts` could not see because it never checked what followed
a failure. After: `service.test.ts` pins the build arguments, the rollback order (failed build →
switch back → rebuild, with no `launchctl`), and the double-failure message.
