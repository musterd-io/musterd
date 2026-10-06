# 537 — The whiteboard is Squig only: tldraw is dropped and Squig is vendored into the package

- Status: accepted
- Date: 2026-10-06
- Deciders: nick (asked for it), stanley (lane `01M49DRSSQXBH58SEWEMK2QP5M`)
- Relates to: ADR 330 (the agent whiteboard and its provider port), ADR 524 (Squig adapter,
  tldraw fallback), ADR 527 (one whiteboard MCP), AGENTS.md hard rule 6 (no new runtime
  dependency without an ADR)
- Spec: `docs/superpowers/specs/2026-10-06-whiteboard-squig-only-design.md`

## Context

Lane `01M2PAMFW1` takes `@musterd/whiteboard` out of the monorepo and publishes it to npm. On
2026-10-02 nick parked it, because the package bundles tldraw in `dist-web`, and the only tldraw
license available is a trial. ADR 524 then made Squig the default canvas. On 2026-10-06 nick
asked to ship the whiteboard without tldraw.

Squig is Pablo Stanley's canvas, and it is MIT licensed. It is not published to npm. It runs from
a local clone (`~/.squig/src`) that someone has built with `pnpm build:local`.

## Problem

ADR 524 decision 2 uses Squig only when such a clone exists, and falls back to tldraw otherwise.
A stranger who runs `npx @musterd/whiteboard` has no clone, so they would get tldraw. The package
therefore cannot be published while it contains tldraw. It also cannot drop tldraw while Squig
needs a clone that a stranger does not have.

## Decision

1. **tldraw is removed from `@musterd/whiteboard`:** the adapter, the sync rooms, the browser page,
   the `/ws/:name` route, `WHITEBOARD_PROVIDER` and the provider choice. This supersedes ADR 524
   decision 2. When Squig cannot start, `whiteboard_open` fails and gives the reason. The
   `WhiteboardProvider` port stays (ADR 330 decision 3).
2. **Squig is vendored.** `packages/whiteboard/scripts/vendor-squig.mjs` does these steps:
   - it builds Squig at a pinned upstream commit;
   - it bundles the local companion (entry `scripts/agent/local.ts`) into one ESM file;
   - it writes the result to `packages/whiteboard/vendor/squig/`, with Squig's `LICENSE` and a
     `VENDORED.json` manifest (commit, externals, file checksums).

   The output is committed. CI never builds Squig. A Squig upgrade is a PR that runs the script
   again. No Squig source is patched.
3. **The adapter prefers the vendored companion.** `SQUIG_CHECKOUT` still points it at a clone,
   for testing a newer upstream. If the override is wrong, the open fails and names the path; it
   does not fall back to the vendored copy. The default no longer reads `~/.squig/src`.
4. **New runtime dependencies:** `@resvg/resvg-js` (MPL-2.0) and `sharp` (Apache-2.0). Squig's
   renderer loads them, and `whiteboard_render` (ADR 527) needs them. They stay outside the
   bundle because they ship per-platform binaries. Their versions equal the ones in
   `VENDORED.json`. The pure-JavaScript packages that Squig uses are compiled into the bundle.

## Alternatives rejected

- **Make the native packages optional dependencies.** Then `whiteboard_render` would silently
  disappear on platforms where they fail to install. A heavier install is the smaller harm.
- **Clone and build Squig on first run.** This needs git and pnpm, and the Next.js build takes
  minutes. It is a fragile first impression.
- **Build Squig in CI on every build.** This means 665 MB of dependencies and a Next.js build on
  every run, while the `ci-cost` goal is open.
- **Wait for an upstream npm package.** The timing is not ours to set. If one is published that
  includes the local companion, it replaces the vendored copy.

## Consequences

- The package grows by about 9 MB: the editor build (7.1 MB), the fonts (1.0 MB, OFL) and the
  companion. `sharp` with libvips adds about 18 MB when installed on macOS arm64.
- The live Squig test runs everywhere, CI included, because the companion is in the repository.
- Pablo Stanley's MIT notice ships in `vendor/squig/LICENSE`. The package README credits Squig.
- nick's tldraw boards are archived, and the one real board is converted through the port, before
  the tldraw adapter is deleted (spec §7).

## Observability & Evaluation

- **Traces:** `/healthz` reports the provider and whether the companion is vendored or comes from
  `SQUIG_CHECKOUT`. A failed start puts its reason in the `whiteboard_open` error.
- **Eval:** `src/squig/vendored.test.ts` checks the manifest checksums and the externals'
  versions. `src/no-tldraw.test.ts` packs the package and fails if any tldraw path or package is
  in it. The dataset is the Squig adapter's round-trip suite
  (`src/squig/provider.test.ts`) plus the live test against the vendored companion. The baseline
  is the same suite as it passed against a `~/.squig/src` clone under ADR 524.
- **Experiment:** the first external installs after the publish (lane `01M2PAMFW1`). If they
  report that install time or size is a problem, revisit making `sharp` optional (it only
  normalizes WebP).
