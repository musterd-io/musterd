# 568 — The preview is over: the home page installs

- Status: accepted (2026-10-12, nick, in session with miley)
- Date: 2026-10-12
- Lane: `01M4RCBXVYXXDMB1T3TZF787XJ` (goal `home-page-cut`)
- Settles: [ADR 565](565-repo-public-musterd-io.md) decision 5, which left "whether the preview is
  over" to nick. Reverses the private-preview removal of the install path recorded in
  [ADR 302](302-musterd-io-public-site.md)'s Consequences (2026-10-03).

## Context

ADR 565 made the platform repo public and said the install path was a separate decision. nick made
it on 2026-10-12: "we've made musterd public, so no more early access. We need steps to
download, install and get started."

Two facts stood between that and an honest page, both checked the same day:

1. `@musterd/cli` on npm was 0.4.2, published 2026-08-24, 1,330 commits behind `main`.
2. The Homebrew tap `SandRiseStudio/homebrew-musterd` was private, so `brew tap` failed for anyone
   outside the org.

## Problem

A page that tells strangers to install has to point at something current that they can reach.
Neither path above was both of those.

## Decision

1. **The private preview is over.** No surface asks for early access. The Tally form leaves the
   site: the hero, Getting started and `/start` no longer link it, and `EARLY_ACCESS_URL` is gone.
2. **Getting started is the install, in three steps with the commands themselves:**
   `npm install -g @musterd/cli` (Homebrew as the alternative), `musterd init` in the project's
   folder, then `musterd tour`. It links `/start` and the source.
3. **The hero's primary button is "Get started"** and goes to that section. The note under it says
   what the reader agrees to: open source under MIT, runs on their machine, no account.
4. **A release comes first.** nick cuts one with `pnpm release` (ADR 156, credentials stay with the
   human) and makes the tap public. This page does not merge until `npm view @musterd/cli version`
   is that release and `brew tap SandRiseStudio/musterd` works signed out.
5. `llms.txt`'s Status line states the install instead of "no public install yet".

## Consequences

- homepage-copy-spec §0a.6 gets a dated note pointing here; the `Request a seat / Not yet` rows it
  specified are retired.
- The Getting started harness list is `musterd init`'s own detection list
  (`packages/cli/src/onboard/harnesses/index.ts`: Claude Code, Cursor, Codex, OpenCode, Grok). A
  harness added there without updating the sentence makes the page understate, not overclaim.
- The README Quickstart already showed npm and brew; it needs no change.

## Observability & Evaluation

**Traces.** n/a — a prerendered marketing page.

**Eval.** Before merge: run the three commands in a clean shell on the released version, signed out
of GitHub, with `MUSTERD_CONFIG` and `MUSTERD_DB` pointed at a scratch directory.

**Experiment.** n/a.

## Falsifier

After this lands and deploys, run `npm install -g @musterd/cli && musterd init` in an empty folder
on a machine that has never run musterd. If it fails, or installs a version older than the release
of decision 4, the page is lying and this ADR is not implemented.
