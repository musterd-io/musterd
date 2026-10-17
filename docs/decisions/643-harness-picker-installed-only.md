# 643 — An uninstalled harness cannot be newly selected

- Status: accepted
- Date: 2026-10-17

## Context

ADR 281 §2 let `musterd init` and `musterd harness configure` select a supported harness that is
not installed. The selection is saved as `pending`, and `musterd wire` configures it once the
install lands.

On 2026-10-17 a human ran `musterd harness configure` in a workspace and picked muse. The machine
had no muse CLI. The receipt printed `muse · pending (muse install not found)` and then
`✓ worktree configured`. They then typed `muse` and got `command not found`. Their words: "user
should not be able to configure muse for musterd if muse cli is not even installed".

## Problem

The picker offered an uninstalled harness on equal terms with an installed one. The only signal was
a dim hint. The command then ended on a green check, so a pending row read as done. Nothing on
that path tells the human to install anything first.

## Decision

1. **The pickers offer only installed harnesses.** This covers `init`, `connect` and `harness
   configure`. An uninstalled harness is named once, with the way in: install it, then run
   `musterd harness configure`. It is not offered as a choice.
2. **A harness already in the desired set stays offered,** even if it is uninstalled now. A human
   can still deselect it, and an existing pending selection (from before this ADR, or from an
   uninstall afterwards) is kept and reconciled exactly as ADR 281 §3 says.
3. **`harness configure --select` refuses a new uninstalled harness.** It exits 2, names the harness
   and its availability detail, and writes nothing. That rule also covers the headless form, so a
   script cannot add what the picker would not offer.

Availability is each adapter's own check, the same one the reconcile receipt reports. Muse's
`init` scan used to count a leftover `~/.config/muse` as an install. It now uses the binary check
that its adapter uses, so the two agree.

## Consequences

- Installing a harness after `init` now needs one more step, `musterd harness configure`. Before,
  `musterd wire` would have picked up the earlier pending selection.
- `musterd connect` skips its agent picker when no external harness is installed. The repos still
  get the native host.
- The `pending` reconcile result still exists for selections made before this ADR, and for a
  harness uninstalled after it was selected.
- **2026-10-17: Codex, OpenCode and Grok read the binary too.** Their check was a config dir
  (`~/.codex`, `~/.config/opencode` or `~/.local/share/opencode`, `~/.grok`). So after an uninstall
  the pickers still offered them. `detect()` and `availability()` now use each launcher's own
  resolver. `availability()` goes through the reconcile `ctx.exec` seam, and an injected probe is
  never cached. Cursor keeps its `~/.cursor` check: it is an editor, with no CLI to probe.

## Observability & Evaluation

n/a — a CLI selection rule with no agent-facing behaviour. It is covered by tests in
`packages/cli/src/commands/harness.test.ts`: refusing a new uninstalled select, keeping an
existing pending one, and the picker split.
