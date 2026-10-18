# 658 — An agent seat's harness denies musterd's own store files

- Status: accepted
- Date: 2026-10-18

## Context

`docs/design/seat-memory-isolation.md` names the laptop tier's paths 3 and 4: an agent on the
same machine reads another seat's note by opening the daemon's database, or the files beside
it, with its ordinary file tools. The ADR 261 floor allows unscoped `Read` and `Bash(cat *)`, and
its `deny` list is empty by construction, so a Claude Code seat reads `~/.musterd/musterd.db`
without being asked. ADR 657 then added a third file to that set: `~/.musterd/note-key.json`,
the machine's private key, which opens a human's sealed note. ADR 657 named "a human's own
agents read the key" as its gap and routed it here.

Two harnesses can enforce a read deny outside the workspace: Claude Code (permission rules for
its file tools, plus a Seatbelt/bubblewrap sandbox for Bash) and Codex (a named permission set, which Codex calls a `profile`,
OS-enforced for shell commands). The design doc's per-harness table records the rest.

## Problem

Which files can musterd deny without breaking the agent's own CLI, and how does it write the
deny into each harness without overriding a sandbox choice a human already made?

The constraint is that agents run `musterd` from their own shell. That CLI reads its folder's
`.musterd/binding.json` and `~/.musterd/config.json`, so an OS-level deny on either breaks it.
Checked for this ADR:

- **`musterd.db`:** no agent-side command opens it. Agent commands reach the daemon over HTTP.
  Only the human commands `store`, `reset` and `service` open the file.
- **`trace.db`:** only the daemon opens it (`packages/server/src/config.ts`). The trace hook
  reports its size through `/health`.
- **`note-key.json`:** opened only by `sealForSeat`/`openForSeat`, and only for a human seat
  (ADR 657). An agent seat never seals.

Two Claude Code facts (code.claude.com/docs, read 2026-10-18) shape the rest:

- A `Read(...)` deny rule stops the Read, Grep and Glob tools, and `cat`/`head`/`tail` in Bash.
- Claude Code also merges every `Read(...)` deny path into the Bash sandbox's `denyRead`.

So a deny that is meant for the file tools only cannot be written as a Claude Code rule. Once
the sandbox is on, it stops the CLI too. The design doc's `Read(<roster home>/**/.musterd/**)`
(other seats' bindings, file tools only) is therefore not buildable as specified.

## Decision

1. **The store wall: three files, nothing wider.** `~/.musterd/musterd.db` and `trace.db` (each
   with its `-wal`/`-shm` sidecars) and `~/.musterd/note-key.json`. When the dogfood overrides
   move them (`MUSTERD_DB`, `MUSTERD_TRACE_DB`, `MUSTERD_NOTE_KEY`, or `MUSTERD_CONFIG` for the
   key), the wall names the moved path too, if it is absolute. `storeFiles()` in
   `permissions.ts` is the one list. The Claude Code and Codex renders below both come from it.
   Not on the wall: all of `~/.musterd`, `config.json`, and any `binding.json`. The CLI reads
   them (see Problem).
2. **Claude Code: `permissions.deny` `Read(...)` rules, written on top of the ADR 261 floor.**
   `Read(~/.musterd/musterd.db*)`, `Read(~/.musterd/trace.db*)`, `Read(~/.musterd/note-key.json)`.
   A path outside home is written as `Read(//abs)`. These rules ride the existing ledger-owned
   `permissions` fragment and `installSeatPermissions`. Deny beats allow, so the floor's `Read`
   stays and is narrowed. The floor itself stays allow-only (ADR 261 decision 2). The wall is a
   separate list, merged in beside it. No separate `sandbox.filesystem.denyRead` is written,
   because Claude Code derives it from these rules whenever the sandbox is on. musterd does not
   turn the sandbox on: that changes every Bash call the seat makes, and is the human's call.
   `inspectSeatPermissions` reports a seat whose block lacks the wall, and
   `musterd init --refresh-permissions` repairs it.
3. **Codex: a `musterd` permission set in the project `.codex/config.toml`.** It sets
   `extends = ":workspace"`, plus `"<path>" = "deny"` under `[permissions.musterd.filesystem]`
   for each file and sidecar. Exact paths are used, not globs, because Codex captures a glob deny
   when each process starts, so a `-wal` created later would stay readable. The permission set is a new
   managed fragment (`permissions`) in the Codex adapter.
4. **Codex: select the permission set only when nobody else chose the sandbox.** Codex loads a project
   file only for a trusted project, and there its implicit default is already `:workspace`. So
   `default_permissions = "musterd"` narrows access and never widens it. It is written only when
   neither the project file nor `~/.codex/config.toml` already has any of the following:
   - a top-level `sandbox_mode`, which overrides named permission sets anyway;
   - a `default_permissions` of the human's own, which is theirs, and taking it over could widen
     a `:read-only` choice;
   - a `[sandbox_workspace_write]` table, which an explicit `:workspace` would drop.

   In those cases the permission set is written but not selected, and the matrix says so. Removing the
   fragment takes out its tables, and `default_permissions` only when it names `musterd`.
5. **Everyone else is written down, not implied.** `04-cli.md` carries the per-harness matrix
   (§Store wall). Cursor and OpenCode have file-tool-only patterns. Grok and Muse are not
   established. This lane writes neither, and the matrix says **none** for both.

## Consequences

- A Claude Code seat's file tools, and its plain `cat`, no longer read the daemon's database or
  the note key. With the sandbox on, its Bash does not either. Every claude-code seat picks this
  up on its next provision or `musterd init --refresh-permissions`. Session start reports the
  gap until then.
- A Codex seat in a trusted project with no sandbox choice of its own runs shell commands under
  `:workspace` minus the store files, enforced by the OS. A Codex seat whose human set
  `sandbox_mode` is not covered. That gap is stated, not fixed.
- Still open, as the design doc says: `--dangerously-skip-permissions`, `--sandbox`/`--yolo`, an
  agent editing its own settings file, MCP servers and hooks, which run outside both sandboxes,
  and any process running as the same user. A courtesy wall, not a boundary. The hosted tier
  (lane 7) is where a seat stops being able to read these files at all.
- Other seats' `binding.json` is not denied (see Problem). The seat-mismatch refusal (lane 3,
  ADR 653) already covers the most likely accident on that path: running `musterd` in a
  sibling's folder.
- The Codex permission-set syntax is marked beta upstream (since rust-v0.113.0). If its
  shape changes, the `permissions` fragment observes as drift and reconcile reports it. It does not
  fail silently.
- `docs/design/seat-memory-isolation.md` laptop item 2 gets a dated note pointing here for what
  was built and what was dropped.

## Observability & Evaluation

- **Traces:** n/a — this writes harness config. No new event is emitted. The existing
  reconcile ledger records the `permissions` fragment write for both harnesses.
- **Eval:** the canary is `permissions.test.ts` § the store wall, and `codexFragments.test.ts` §
  the ADR 658 permission set. Both are written, observed back, and removed. A live check on a
  provisioned seat: `musterd init --refresh-permissions`, then ask the agent to `Read`
  `~/.musterd/musterd.db`. Claude Code refuses it with the deny rule named.
- **Experiment:** n/a — a config change with a fixed expected outcome. There is nothing to
  compare against.
