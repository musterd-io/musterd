# 717 — Bare musterd in a member workspace starts only that member

- Status: accepted
- Date: 2026-10-22
- Deciders: nick (asked for it 2026-10-22)
- Goal: `launch`
- Lane: `01M5JN16RJ5CEQ35EAMT2V0Y38`
- Relates to: ADR 491 (the seat launcher — Decision 1 is amended here)

## Context

Bare `musterd` on a terminal opens the seat picker (ADR 491). The picker lists every seat on the
machine, and `⏎` starts whichever row the cursor is on. The same binary, run from a member
workspace, already treats that folder as the member for commands that read the binding (ADR 413).
The launcher did not. From ghost's workspace, `⏎` on stanley started stanley.

## Problem

nick, 2026-10-22: running `musterd` inside a member workspace should still show teams and members,
and should start a session only as that member. The same screen should list the harnesses
configured for that member, mark the one used last, and offer a way to change that set without
leaving for `musterd harness configure`.

A human seat has no harness list (ADR 491 Decision 5): `⏎` opens a login shell. A chat folder or a
role folder is not one member. From `~`, or from a checkout that is not a seat, the machine-wide
picker stays the front door.

## Decision

1. **A seat workspace scopes the start.** The launcher walks up from the working directory to
   `.musterd/workspace.json`, the same walk the rest of the CLI uses, and a subfolder counts. It
   scopes when that file's claim is `mode: seat` and the name is the member. Bare `musterd` on a
   TTY then starts only that member. The recent screen still lists the other seats and the teams.
   `⏎` on another member, on another member's wake or set-up row, or on `+ new seat`, does not
   launch and does not open a harness list. One line: `this folder is ghost — stanley starts from
   /path`. A member with no workspace on this machine reads `this folder is ghost — bo starts from
   bo's own workspace`. A new seat reads `this folder is ghost — a new seat starts from a folder
   that is not a member workspace`. `musterd stanley`, typed in ghost's folder, prints the same
   line and exits 1. `musterd ghost`, `--harness`, and `-r` for this member still launch.
   `musterd -` refuses when the last seat is not this member.
2. **The walk stops at the first workspace file.** A chat claim or a role claim is no scope, and
   the full picker stays. A file that cannot be read, or that is not a seat claim, is no scope.
   The walk does not continue to a parent seat. `MUSTERD_BINDING` scopes only when the walk finds
   no workspace file and the binding's workspace is this directory or inside it. A binding that
   points outside the tree does not scope. The paint path copies `team` and the seat-claim name
   and drops the rest of the file. It does not write the file to stderr.
3. **An agent member's workspace opens on that member's harness step.** The step is the one ADR
   491 already shows, including when one harness is configured, with the one used last marked.
   The last row reads `change harnesses`. `⏎` on it runs the existing configure prompt for this
   workspace, which replaces the set, and returns to the step with the cursor on the harness just
   added — the first new id in the saved order. Cancelling writes nothing and leaves the cursor
   on the one used last. The count line counts configured harnesses and does not count the extra
   row. `esc` returns to the recent list, so teams stay one key away. The row is absent outside a
   member workspace, so frame 24 stays as it is.
4. **A human member's workspace stays the recent screen.** The cursor rests on that member when
   the row is on the screen. `⏎` opens a login shell. There is no harness step. A second session
   of the scoped member still asks before it launches (ADR 491 Decision 6).
5. **Anywhere else, ADR 491 stands.** From `~`, or from a checkout that is not a seat workspace,
   bare `musterd` is the machine-wide picker. `--path` prints a workspace path and launches
   nothing, including for another member. Waking and setting up this member stay. Read commands
   stay. This decision covers starting a session from the launcher.

## Alternatives rejected

- **Hide the other members.** nick asked to see teams and members, and to start only this one.
- **A row that adds one harness.** `musterd harness configure` replaces the whole set. The row
  says `change harnesses` so the screen matches the write.
- **Apply the same refusal to every command.** The ask was about starting a session. Commands
  that already follow the folder's binding stay as they are.

## Consequences

- ADR 491 Decision 1 carries the marker. The picker tests, the name-launch tests, and frame 24a
  in `docs/design/figma-brief-terminal.md` change in this commit.
- The first frame inside an agent workspace can be the recent list for a moment, then the harness
  step, when the snapshot does not yet hold the seat. A key pressed before that catalog arrives
  keeps the list.
- Configure runs after the terminal is restored, through a dynamic import, so the paint path
  still does not load a command module.

## Observability & Evaluation

- **Traces:** none new. A launch still records itself in `~/.musterd/launcher.json`. A refusal is
  a `CliError` whose line names the member and a path, and holds no secret. The folder read
  copies two strings and drops the rest of the file, including anything that looks like a
  credential.
- **Eval:** `packages/cli/src/launcher/store.test.ts`,
  `packages/cli/src/launcher/picker/state.scope.test.ts`,
  `packages/cli/src/launcher/picker/view.test.ts`, `packages/cli/src/launcher/byName.test.ts`,
  and `packages/cli/src/commands/harness.test.ts` assert the scope, the refusal line, the harness
  row, and a configure read from a subfolder. Dataset: the picker fixtures in those files, and
  temporary workspace directories each test creates. Baseline: frame 20, frame 24, and the
  `launchByName` suite as they stood before this ADR, which start any seat from any directory.
- **Experiment:** nick runs bare `musterd` in ghost's workspace, and again from `~`. Falsifier:
  from ghost's workspace he can start stanley, or from `~` the picker no longer lists the other
  seats.
