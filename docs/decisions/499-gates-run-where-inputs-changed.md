# 499 — CI gates run where their inputs changed: a docs-only change runs the docs leaf alone, and the a11y leaves run when the web client changed

- Status: proposed
- Date: 2026-10-03
- Deciders: izzo (nick: "lets do all of these levers", 2026-10-03, after GitHub refused to start any
  job over the org's Actions spending limit and a $10 budget was set)
- Lane: `01M3ZYPH3HAW3RW96SN0EQ1HAE` (goal `ci-cost`); builds on ADR 498's `plan` job
- Relates to: ADR 106 (one enforced workflow — "every gate runs on every PR"), ADR 492 (the PGlite
  leg runs where it can catch something), ADR 498 (the sharded coverage leaf)

## Context

Since the repo went private (2026-10-02) every Actions minute is billed, and on 2026-10-03 GitHub
stopped starting jobs for the whole org: "recent account payments have failed or your spending
limit needs to be increased". nick set a $10 budget — about 1,250 runner-minutes at 2-core Linux
pricing. A push to `main` bills ~37 minutes (five leaves, each with its own install and build), a
SQLite-only pull request 15–20, and the repo runs 100–166 CI runs a day. A large share of those
runs are ADRs, wiki pages, perf pages and plans: changes under `docs/` or to a root `*.md`, for
which the test suite, the typecheck and the Chrome contrast sweeps prove nothing — nothing they read
changed. The two a11y leaves (~3.5 and ~2.5 minutes plus two setups) run on every change, though
they sweep only the built web client.

ADR 106 made every gate run on every PR so that running a subset locally could never be mistaken
for green. That rule was written when minutes were free; the gates it protects still run — where
they have something to read.

## Problem

Minutes are spent proving nothing, at a rate that empties the budget in hours, and the fix must not
reopen the hole ADR 106 closed: a leaf that is skipped must be a verdict the fan-in can tell apart
from a leaf that never ran.

## Decision

1. **`plan` classifies the diff** (the ADR 498 job; a checkout and a `git diff --name-only
   HEAD^1 HEAD`, ~20 s). A pull request's checkout is GitHub's merge commit and a push to `main`
   is the squash commit, so the same range is the change in both cases; with no parent to diff,
   everything runs.
   - **docs-only**: every changed path matches `^docs/` or `^[^/]+\.md$`. Then `suite=false`
     and `a11y=false`.
   - **a11y**: on when any changed path matches `^(packages/web/|scripts/a11y/|\.github/|
     package\.json$|pnpm-lock\.yaml$)` — the client, the sweep scripts, the workflow, the deps.
   - The ADR 492 driver pick and the ADR 498 shard count are unchanged.
2. **Leaves carry the verdict as an `if:`.** `static`, `coverage` and `coverage-merge` run when
   `suite` is true; `a11y-prerender` and `a11y-connected` when `a11y` is true; `docs` always —
   on a docs-only change it is the gate that can fail (`format:check` with the wiki, roadmap,
   arch-tree, vocabulary and intent gates, then `change-adr:check`).
3. **`gates` sanctions exactly the skips `plan` announced.** Its rule stays "every needed job
   succeeded by name", with named exceptions: `static`/`coverage`/`coverage-merge` skipped while
   `suite=false`; `coverage-merge` skipped while the shard count is 1 (ADR 498); the a11y leaves
   skipped while `a11y=false`. A leaf skipped for any other reason, or cancelled, is red. `plan`
   itself is in `needs`, so a failed classification is red too.
4. **The same classification applies to pushes to `main`.** ADR 492's "a push to `main` always
   runs both drivers" holds whenever the suite runs; a docs-only squash runs no suite on either
   engine, because no engine's inputs changed. `.github/**` counts as suite-affecting and
   a11y-affecting, so a change to this workflow runs everything.

Weighed and rejected: GitHub's `paths-ignore` on the workflow trigger — a PR that triggers no
workflow leaves `gates` absent, and a required check that never reports blocks the merge with no
verdict (the outage ADR 106's `if: always()` exists to prevent). Skipping the `docs` leaf on code
changes — `format:check` reads the architecture trees against the source and `change-adr:check`
reads the diff for protocol and dependency changes; code changes are its inputs. A broader
"docs-like" set (`.agents/`, `.claude/`, `.cursor/`, `AGENTS.md`) — guidance and skill text is
read by tests in `packages/protocol` and `packages/cli`; it stays code.

## Consequences

- A docs-only change bills `plan` + `docs` + `gates`, about 2.5 minutes, instead of 15–37. A code
  change that leaves `packages/web` alone saves the two a11y leaves, about 8 billable minutes. A
  web or workflow change runs everything, as before.
- A PR's set of checks now varies with its diff; `gates` is still the one required check and still
  the only thing branch protection reads (ADR 106 §2). The `plan` step summary says what ran and
  why, for the reader of a PR with grey leaves.
- The classification is by path, so a file that moves into a test's inputs without moving into the
  pattern (a test that starts reading `docs/…`) would be missed — `docs` still runs, and the next
  push of code runs the suite. If that happens, the pattern narrows; the rule does not revert.
- ADR 106 and ADR 492 carry dated notes pointing here. The remaining compute lever, the PGlite
  leg's per-test cost, is lane `01M3ZRQAGDDMTG6TA9T27D02N9`.

- 2026-10-03, first reading: #2012 (server code, `packages/web` untouched) ran with both a11y
  leaves skipped by `plan` and `gates` green — the web-free shape works. The docs-only shape is
  read on the PR that carries this note.

## Observability & Evaluation

**Traces.** No new trace event. The `plan` job's step summary names the verdict per run; GitHub's
run and job timings (`gh run view <id> --json jobs`) and the org's Actions usage page are the
record of what it saved.

**Eval.** Dataset: CI runs on `main` and on pull requests for the seven days after landing, against
the seven before (100–166 runs/day; a `main` push ~37 billable minutes, a SQLite-only PR 15–20).
Target: docs-only runs show `plan`, `docs` and `gates` green with every other leaf skipped and bill
under 4 minutes; code PRs without `packages/web` changes show both a11y leaves skipped; the org's
billable minutes per day fall by at least a third at the same run count. The $10 budget set on
2026-10-03 lasting past the day it was set is the first readable signal.

**Experiment.** n/a — the before/after on the same repository is the comparison; the path sets are
the knobs, and Consequences says how they move.

Falsifier: a leaf that reads a changed file and was skipped (a test that depends on a `docs/` path,
a sweep that depends on a path outside the a11y set); a `gates` run green with a leaf skipped that
`plan` did not announce; or a docs-only PR that still bills more than 4 minutes.
