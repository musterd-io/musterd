# 669 — The release train: one ordered, self-checking way a musterd version leaves

- Status: accepted
- Date: 2026-10-19
- Deciders: nick (D1–D6, in-session), slippy (carried); reviewed by sloane (traction plan) and alfie
  (positioning)
- Relates to: ADR 156 (lockstep npm + brew — stays; this ADR orders what follows it), ADR 308 (site
  deploy — miley's, unchanged), ADR 568 (the install path strangers see), ADR 666 (agent discovery —
  the registry and docs indexes), lanes 01M5ASVF3GAAE17TY3S3AX9SF0 (this), 01M5AQGV8Y0TNVSVQ68PX9C7SY
  (registry); spec `docs/superpowers/specs/2026-10-19-publish-launch-train-design.md`

## Context

musterd ships through seven surfaces — npm, Homebrew, the MCP Registry, musterd.io, /live, GitHub
Releases and the docs indexes — each with its own owner and its own idea of "current". On
2026-10-19: npm sat 499 commits behind main; no release had ever carried notes (no CHANGELOG, no
GitHub Release); four places gave a stranger four different install commands; every post-publish
step was a line printed to a terminal and remembered or not; and the launch (traction-plan §7,
Oct 28 – Nov 2) was nine days away with no release to point at. The spec measures each of these.

## Problem

What is the one way a version of musterd leaves, in what order, owned by whom, and how does anyone
know it finished — without moving the npm credentials off a human (ADR 156) or adding a calendar
nobody asked for?

## Decision

1. **D1 — One train.** A version leaves through every surface in a fixed order, each car checked
   before the next: gate (run 4 on a clean machine, Claude Code and Codex) → release notes → npm
   (`pnpm release`) → tag + GitHub Release → MCP Registry → Homebrew → site (miley) → docs indexes.
   Launch day adds traction-plan §7, in its order. Owners are the spec's §5 table.
2. **D2 — No fixed cadence.** Ship as fast as it makes sense: a train leaves when main has a change
   a user would notice, or a fix one is waiting for. 0.x versions: minor for anything a user would
   notice, patch for fixes. The launch train is **0.6.0**. A red gate stops the train.
3. **D3 — npm publish stays on nick's laptop** (ADR 156 unchanged) for 0.6.0. CI publishing with npm
   trusted publishing is revisited after launch, under its own ADR, because it reverses ADR 156's
   "no CI publish".
4. **D4 — Registry name `io.musterd/musterd`**, DNS-verified on musterd.io (#2923).
5. **D5 — Release notes are generated, then edited by a human**, kept as `docs/releases/vX.md` and
   used as the GitHub Release body. No CHANGELOG.md beside them — one fact, one home.
6. **D6 — `www.musterd.dev` and `musterd.dev` 301 to musterd.io** (done 2026-10-19; `*.musterd.dev`
   untouched, where hosted teams live).

Three pieces of tooling make the order hold rather than be remembered (spec §3): `pnpm train
status` (read-only, every surface red/green), `pnpm train notes` (draft notes from merged PRs), and
one install block every surface renders from, with a test that fails when any surface disagrees.

## Consequences

- traction-plan §7's "set the version that morning" step retires with the install block; sloane
  edits §7 in the lane that moves the launch post to 0.6.0 (#2933).
- The MCP Registry listing and the docs-index submissions wait for 0.6.0 (0.5.0 carries no
  `mcpName`).
- Until the tooling lanes land, `nextStepsAfterPublish` in `scripts/release/helpers.ts` remains the
  checklist, and it already prints the registry step.
- 2026-10-19: `pnpm train status [--version X]` and `pnpm train notes --version X [vPREV..HEAD]`
  landed (lanes `01M5AXB7VW`, `01M5AXBAFG`; `scripts/train/`). First reading, against 0.5.0: npm,
  tag, Homebrew and the site ✓; **no GitHub Release ✗** (0.5.0 never had one); MCP Registry `?`
  from a machine that could not reach it. A notes draft for v0.5.0..main took 75 s and kept 350 of
  521 commits under 30 goals — the editing pass is where it becomes a release body.

## Observability & Evaluation

**Traces.** n/a — release tooling runs on a laptop and in CI, not on an agent path.

**Eval.** The train's own numbers, logged per release: days from tag to all-green `train status`
(failing: > 2 days, meaning a car has no owner) and whether the MCP Registry lists the tagged
version. The install-block agreement test is the falsifier for "one install path": it fails on any
surface that renders a different command. Launch targets and passive proxies stay in
traction-plan §13.

**Experiment.** n/a — a process decision; the 0.6.0 train is its first run, read against the two
numbers above.
