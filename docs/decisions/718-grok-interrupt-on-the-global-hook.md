# 718 — Grok's interrupt hooks live in the global file, so the first session has them

- Status: accepted
- Date: 2026-10-22
- Builds on: [ADR 370](370-grok-interrupt-injection.md) (the seams), [ADR 352](352-grok-first-class-harness.md) (the one global SessionStart write), [ADR 408](408-a-workspace-repair-is-an-audit-row.md) (the project file is written inside SessionStart)
- Lane: `01M5JNJTQ5CYTKBPHSKGH8AKH6`

## Context

ADR 370 puts the Grok doorbell on PreToolUse `additionalContext` and one Stop block. The installer writes both into the project file `.grok/hooks/musterd.json`. Grok snapshots hook files when the session is created and does not rescan. Uninstall takes effect next session. A file that appears after that snapshot is not in it.

The writer of a missing project file, for an interactive session, is that session's own global SessionStart. `musterd session start` heals the workspace, and the heal calls `installMusterdGrokHooks`, which creates `.grok/hooks/musterd.json`. Measured on dreamy, 2026-10-22, Grok 1.0.67 (`2fe064390d07`), session `01a16542-cb96-7cf3-a47f-784e3a182ee0`: the session folder was created at 20:17:19.057Z and the project hook file at 20:17:19.346Z. The loaded hooks were `global/musterd-sessionstart` and `global/settings`. Across the turn, `updates.jsonl` has no `project/musterd:pre_tool_use`. The same agent on sloane the same day, whose project file had existed since the day before, recorded 71 user `system_reminder` lines from `project/musterd:pre_tool_use`.

ADR 408 already moved the heal to before a wake, because a Grok folder with no hook file cannot heal itself. An interactive first session is still healed from inside SessionStart, which is after the snapshot.

The global SessionStart file `~/.grok/hooks/musterd-sessionstart.json` has existed on this machine since 2026-10-05. It was in the snapshot. Global hooks run in the workspace root, so a `musterd:start` grep against `AGENTS.md` sees the folder the session launched in.

The Grok 1.0.67 user guide says `~/.grok/hooks` waits on folder trust, same as a project hook, except a headless `grok -p` treats the folder as trusted for your own hooks. This session did run the global SessionStart hook, so this folder had cleared that gate. ADR 473's 2026-09-29 note that global hooks are always trusted was measured on 1.0.40.

## Problem

The first interactive session in a folder whose project hook file does not yet exist never loads the interrupt. The file is written during SessionStart, and Grok does not pick it up. Every later session in that folder does, once the file is on disk before launch. A busy seat in that first session does not see a directed act. The Stop continuation does not fire either.

Putting the same commands in both files doubles the line on the second session (ADR 597 is that class of bug). Skipping the global command once the project file exists does not help the first session: the project file is on disk before the first PreToolUse, and it is still not in the snapshot.

## Decision

1. **The interrupt commands move to `~/.grok/hooks/musterd-interrupt.json`.** PreToolUse `additionalContext` and the Stop block, the same scripts ADR 370 specifies, each prefixed with the SessionStart self-gate (`musterd:start` in `AGENTS.md` or `Agents.md`) and a per-workspace decline check. A workspace that declined `grok:PreToolUse` or `grok:Stop` exits 0. Other workspaces keep the hook. The file is one copy for the machine.
2. **The project file drops those two events.** Install and refresh delete a leftover PreToolUse interrupt and a leftover Stop from `.grok/hooks/musterd.json`. A leftover is drift, same as the leftover PostToolUse interrupt. Notification, the ADR 150 gate, SessionStart capture, and SessionEnd stay in the project file.
3. **The SessionStart recovery file stays separate.** `musterd-sessionstart.json` is still only SessionStart. A bad rewrite of the interrupt file does not remove the hook that runs the heal (ADR 408).
4. **A seat heal still writes both global files.** Grok's `refreshHooks` already ignores `withinWorktreeOnly` and rewrites the global SessionStart. This change adds the interrupt file to that same write. The epoch guard still refuses a downgrade. Honoring `withinWorktreeOnly` here would leave the interrupt unwritten on the path that actually creates it.

The ADR 370 scripts are not rewritten. PostToolUse stays dropped. Claude hook compat stays off (ADR 597).

## Consequences

- A session started after this file is on disk loads the interrupt even when `.grok/hooks/musterd.json` is created during that session's SessionStart. A session already running does not. This session (`01a16542`) will not load it.
- The second session does not double the line, once refresh has removed the project copy. A session that snapshotted the old project file and the new global file, before that refresh, still doubles for that one session.
- A decline of `grok:PreToolUse` still skips the project gate. It does not delete the machine-wide interrupt. The command no-ops in the declined workspace.
- `docs/architecture/04-cli.md`'s `grok.ts` line still says the interrupt lives in the project file. Lane `01M5JE041S` holds that file (ADR 691), so this commit does not edit it.
- No `FEATURE_EPOCH` bump. This is a bugfix of where an existing hook is installed, not a capability an older seat cannot render (ADR 148). A same-epoch checkout that still writes the project copy can put the line back beside the global one until this build refreshes the files. The epoch guard stops an older epoch from overwriting a newer one, and it does not stop an equal epoch.

## Observability & Evaluation

- **Traces:** unchanged probe, `inbox --interrupt-check --hook grok`. The new dispatcher name is `global/musterd-interrupt:pre_tool_use` and `global/musterd-interrupt:stop` in the session's `updates.jsonl`. A doubled session also has `project/musterd:pre_tool_use` for the interrupt marker.
- **Eval:** `packages/cli/src/onboard/harnesses/grok.hooks.test.ts`. The global file carries both commands and the self-gate. The project file does not. A leftover project copy is drift and refresh removes it. A missing global file is drift even when this workspace declined the surface. A discarded-stdout same-marker command is STALE. Baseline is dreamy's 2026-10-22 session: zero `project/musterd:pre_tool_use` rows, global SessionStart present, project file born 290ms after the session.
- **Experiment:** none on this session. It cannot rescan. Falsifier: a Grok 1.0.67 session started in a musterd folder after `~/.grok/hooks/musterd-interrupt.json` existed, with a non-empty interrupt line, whose next user message has no `system_reminder` carrying that line. A second falsifier: `updates.jsonl` names both `global/musterd-interrupt:pre_tool_use` and `project/musterd:pre_tool_use` for the interrupt after a refresh in that session's snapshot.
