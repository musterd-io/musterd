# 695 — Project derived from the origin remote, not the folder name

- Status: accepted
- Date: 2026-10-21
- Builds on: [ADR 083](083-surface-overlap-within-project.md) (contention is checked within a project, never across), [ADR 165](165-worktree-invariant-project.md) (`worktree`-invariant project via `--git-common-dir`) <!-- vocab:ok -->
- Lane: 01M5FSHZBK6SYMJADTA00D1WRG

## Context

`resolveProject` (packages/protocol/src/project.ts) derives a lane's `project` from the basename of
the git common dir's folder. That is `worktree`-invariant (ADR 165), so N seats on one repo share a
project — good. But it is folder-name-dependent: two clones of the same repo named `musterd` and
`musterd-fork` (or `agent1/` and `agent2/`) derive two different projects, and contention is checked
within a project only. Their lanes never overlap-warn and never take an ADR 691 hold, even when they
touch the same files. Found 2026-10-21 by hold_smoke.py (lane 01M5FQBPHB). CooperBench is not
affected: both containers' checkouts are `/workspace/repo`.

## Problem

The project name identifies a repo, but it is derived from the local folder name, which is not a repo
identity — it is a checkout label. A clone's folder name is arbitrary, so the same repo derives
different projects under different clones, silently disabling surface-overlap for the whole team.

## Decision

`repoProject` now prefers the **origin remote URL** when the checkout has one: it runs
`git remote get-url origin`, normalizes it (scp-like `git@host:path` and `https://host/path` forms,
trailing `.git`, trailing slashes), and takes the last path segment — the repo name. Only when there
is no origin (a fresh `git init` with no remote, a detached checkout with no remote, or git failure)
does it fall back to the folder-name rule of ADR 165.

The normalization reuses the shape of `remoteRepoName` in packages/cli/src/onboard/workspace.ts, so a
remote and a folder agree on the repo name when both are present.

Consequences for existing lanes: a repo whose folder name differs from its remote repo name changes
project on the next `resolveProject` call. That is the point — lanes that should have contended now
do. Historical lanes keep their stored `project` (nothing rewrites them); only newly opened lanes
derive the new value.

## Consequences

- Two clones of one repo now share a project, so their lanes contend as intended.
- A repo with no origin keeps the old folder-name behavior — no regression for local-only repos.
- Lanes opened before this change are not rewritten; their `project` stays as stored. The change
  affects derivation going forward only.
- One extra `git` spawn per `repoProject` call (remote get-url origin), on top of the existing
  `rev-parse --git-common-dir`. Both are cheap and bounded by a 2 s timeout.

## Observability & Evaluation

Traces: none new. The `project` field on a lane is already recorded (`lane.opened`); a reader can
compare `project` values across lanes of the same origin to confirm convergence.

Eval: n/a — this is a derivation correctness fix, not a measurement. The falsifier is the existing
`project.test.ts` suite plus a new case: two `worktree`s of a repo that has an `origin` remote derive
the same project even when the `worktree` folders differ, and a repo with no origin falls back to the
folder name.

Experiment: n/a — no agent-facing behavior change beyond project derivation.