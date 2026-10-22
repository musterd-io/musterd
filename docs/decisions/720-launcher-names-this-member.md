# 720 — Workspace launcher names this member and the machine

- Status: accepted
- Date: 2026-10-22
- Deciders: nick (asked for it 2026-10-22)
- Goal: `launch`
- Lane: `01M5JTV9112YPYB4BBCH8YX7ZS`
- Relates to: ADR 717 (the workspace-scoped launcher), ADR 503 (the node label), ADR 491 (frame 20)

## Context

ADR 717 opens the harness step when `musterd` runs inside a member workspace, and the last row of
that step read `change harnesses`. The list behind the step is still every seat. A live seat on
the answering daemon's own node was painted `here`. The node's label was already on the roster
(`node.label`) and was dropped for that case, because `where: here` is what `⏎` decides from.

## Problem

nick, 2026-10-22: the row should read `configure harnesses`. The same screen should make it clear
which member this folder is. The other members should show machine names. A member on the same
machine should read `<machine name> (this machine)`.

## Decision

1. **The extra row reads `configure harnesses`.** So does the key line when the cursor is on it:
   `⏎ configure harnesses · ↑↓ choose · esc back`. `⏎` still runs the existing configure prompt for
   this workspace, which replaces the set, and returns to the step as ADR 717 describes. The row
   stays absent outside a member workspace, so frame 24 stays as it is.
2. **A scoped screen names this member.** The header reads `this member · ghost` ahead of the seat
   count. That member's row carries `this member` where a location of `here` would have been. A
   live session on another machine still names that place: `this member · on air-2`. The member is
   kept on the recent list even when this folder has not launched yet. Outside a member workspace
   the header stays `N seats here`.
3. **Other members show the machine, and only when the screen is scoped.** The same machine reads
   `mac (this machine)`, the label in front of the words `(this machine)`. Another node stays
   `on air-2`. Cloud and nowhere stay. Before a loopback roster has named the node, a place that
   would have said `here` reads `this machine`. The label is that roster's `node.label`, with
   control bytes removed. The launcher does not guess a hostname. An idle seat on this machine
   gains the same phrase in front of its last-used tail once the label is known.
4. **`where` stays `here` for what `⏎` can do.** Team rows keep `● here`. `musterd seats`, the
   live-seat question, and frames 20, 22, 23, and 24 do not change. This paint runs only when the
   picker has a folder scope.

## Alternatives rejected

- **Square brackets around the name.** nick wrote `[machine name](this machine)`. The brackets are
  the slot. Painted brackets would look like a link, and every other location on this screen uses
  spaces (`on air-2`, `cloud · fly`). The words are `mac (this machine)`.
- **`os.hostname()`.** ADR 503 already refuses a hostname this machine guesses. Two machines named
  `mac` is what that rule is for. A missing label stays `this machine`.
- **Change `describeWhere` on every screen.** That rewrites frame 20, which ADR 717 left standing
  from `~`.

## Consequences

- ADR 717 Decision 3 carries the marker. Frame 24a in `docs/design/figma-brief-terminal.md` changes
  in this commit. The picker tests pin the row, the header, and the machine phrase.
- The node label arrives with the roster, the same moment `here` used to arrive. The first paint
  from `launcher.json` can still omit it. The header names this member from the folder alone.

## Observability & Evaluation

- **Traces:** none new. The roster read already returns `node.label`. The picker paints it and
  writes no new log line. The label is the node's name, not a credential.
- **Eval:** `packages/cli/src/launcher/picker/view.test.ts` asserts `configure harnesses`, the
  header `this member · ghost`, `mac (this machine)` for another member on this machine,
  `this machine` when the label has not arrived, `on air-2` for a member elsewhere, and that an
  unscoped recent screen still says `here · since` even when a label is present. Dataset: the
  picker fixtures in that file. Baseline: frame 20 and frame 24 as they stood before this ADR, and
  the scoped footer that read `change harnesses`. `packages/cli/src/launcher/live.test.ts` asserts
  `localNodeLabel` takes the loopback node's label, ignores a remote roster, and drops control
  bytes. Dataset: the roster maps in that file. Baseline: a missing or remote label contributes
  nothing.
- **Experiment:** nick runs bare `musterd` in ghost's workspace, and again from `~`. Falsifier:
  the last row still reads `change harnesses`, ghost is not marked `this member`, a teammate on
  this machine still reads only `here`, or from `~` the recent screen no longer says `here`.
