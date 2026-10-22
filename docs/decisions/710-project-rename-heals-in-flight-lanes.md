# 710 — A project rename heals in-flight lanes from the reporting checkout

- Status: accepted
- Date: 2026-10-22
- Amends: [ADR 695](695-project-from-origin-remote.md) (its "historical lanes are not rewritten" is narrowed to closed lanes)
- Builds on: [ADR 083](083-lanes-phase1-intent-dependency.md) (contention is checked within a project, never across), [ADR 165](165-worktree-invariant-project.md) (`worktree`-invariant project via `--git-common-dir`) <!-- vocab:ok -->
- Lane: 01M5FSHZBK6SYMJADTA00D1WRG

## Context

ADR 695 derives a lane's `project` from the origin remote's repo name. It landed on 2026-10-21
(#3128), and this team's own checkout is the case it changes: the git common dir is
`…/runtime/.git` and the origin is `musterd.git`, so a seat derives `runtime` before its adapter
rebuilds and `musterd` after. The board already carries both generations — 89 non-terminal
`runtime` lanes and 16 non-terminal `musterd` lanes on 2026-10-22 — and ADR 083 checks contention
within one project string. The two generations never overlap-warn, never branch-overlap-warn, and
never hold a file against each other.

wallow's review of #3128 named it: ADR 695 §Consequences says historical lanes keep their stored
project, but does not say what happens to lanes that are still open when the derivation changes.
Because the checks are warn-only and the symptom is an absence of warnings, the split lands silently
— the exact no-contention failure ADR 695 set out to fix, inverted and team-wide.

## Problem

A derivation change cannot repair a stored field by itself. `lanes.project` is stamped at open, and
contention and ADR 691 holds compare that string. Existing open lanes keep the old name; new lanes
carry the new one; a boot-time migration cannot compute the mapping, because the database does not
record which folder a lane was opened from and the daemon has no git checkout to ask. Only a client
standing in the checkout can prove that folder `X` and origin `Y` are the same repo, at the moment it
opens a lane from that checkout.

## Decision

1. **The client reports the alias.** `projectAliases()` (packages/protocol/src/project.ts) returns the
   other names a checkout is known by — currently the ADR 165 folder name when the ADR 695 origin
   remote name wins. It shares one refactored derivation with `repoProject`, so it costs no extra git
   spawns. An explicit `--project` or `MUSTERD_PROJECT` returns no aliases: a declaration is not a
   derivation, and it heals nothing.
2. **The alias rides the lane open.** `OpenLaneSchema` gains optional `project_aliases`
   (at most 8 names, 80 chars each). The CLI `lane open` and the MCP `lane_open` send the derived
   aliases; a remote MCP request ([ADR 630](630-remote-mcp-phone.md) §3) has no workspace and sends
   none.
3. **The daemon heals non-terminal lanes on open.** In the open's transaction, every lane whose
   `project` is one of the reported aliases and whose state is neither `done` nor `abandoned` moves to
   the opened lane's `project`. Closed lanes keep their stored project, so ADR 695's promise stays
   true for history.
4. **The move is audited, and nothing else moves.** Each heal writes a `lane.updated` row with
   `fields: ['project']` and `changes.project = {from, to}` — the shape a replicating peer already
   folds. `updated_at` deliberately does not move: a rename is a label change, and an awaiting lane's
   wait age is derived from that stamp.
5. **The heal is one-way and idempotent.** Once healed, no lane matches the alias, so later opens
   write nothing. A lane is never moved into the name it already carries.

### Rejected

- **An alias table expanded at every comparison** (the other repair wallow named). Every reader —
  overlap warnings, branch overlap, ADR 691 holds, the edit gate — would compare name sets forever,
  and every lane would permanently carry two names, for a transition that is one-way and happens once.
- **A migration at boot.** The database cannot know which folder a lane came from, and the daemon has
  no checkout. Only a client can report the pair.
- **Rewriting every stored lane regardless of state.** Closed lanes are history; changing their
  project would rewrite what the record says contended at the time.
- **Doing nothing and documenting the window.** The window lasts as long as any lane opened before
  the upgrade stays open, which on this team is every in-flight lane — not a window.

## Consequences

- This team's 89 non-terminal `runtime` lanes move to `musterd` on the first `lane open` from an
  upgraded CLI or MCP, and from then on contend with, and hold files against, the existing `musterd`
  lanes. No per-seat action beyond running the build that carries this.
- An old-build client can still open a `runtime` lane after a heal; the next open from an upgraded
  checkout heals it. The window is bounded by the adapter rebuild the daemon already asks for
  (ADR 135), and each heal is one UPDATE over the matching lanes.
- Residual risk: two different repos checked out in folders with the same name on one team could be
  merged by a heal. The same name-based assumption already underpins ADR 165 and ADR 695; here the
  alias applies only when a live client proves the pair, and only non-terminal lanes move.
- No envelope or act change: `project_aliases` is a body field on lane open, not a protocol act
  field, and clients that do not send it behave exactly as before.
- The import path (`musterd import …`) derives a project too, but its stage file predates the field
  and opens lanes without aliases; the next ordinary lane open heals whichever names it used.

## Observability & Evaluation

- **Traces:** `lane.updated` rows with `changes.project` and an actor. A reader can count healed
  lanes, see `from`/`to`, and tell a heal from a `lane_update` project edit by the field set (`heal`
  rows carry `project` alone). The board and `GET /lanes` show the healed project directly.
- **Eval:** the falsifier is that the split is gone. On this team,
  `SELECT project, COUNT(*) FROM lanes WHERE state NOT IN ('done','abandoned')` returns no `runtime`
  rows after the first upgraded open, and a lane whose scope names a file a `runtime` lane also named
  now warns (and, under block posture, is held) against it. The store test `a project rename heals
  in-flight lanes (ADR 710)` asserts the move, the resulting `surface_overlap`, that closed lanes
  stay, and that no alias heals nothing.
- **Experiment:** n/a — a derivation/transition correctness fix, with no measured behavior to
  pre-register.
