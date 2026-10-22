# 713 — A role's skill and toolkit are equipped on every harness the seat is wired for

- Status: accepted
- Date: 2026-10-22

## Context

A role names a skill and a toolkit (ADR 586, ADR 708). Holding the role is supposed to put that skill where the harness reads it, and that toolkit's MCP servers into the harnesses the seat is wired for. Seat creation provisioned the recorded toolkit into the desired set once. Adding a harness later, or assigning the role onto a seat that already had a desired set, updated the roster file and the permission ceiling and left the new harness without the servers and without a skill bridge.

On 2026-10-22 the `ios-engineer` role on revive named skill `ios-engineer` and toolkit `ios`. One Workspace recorded toolkit `ios` and desired `grok` and `muse`. Muse had the Expo, XcodeBuildMCP, and Apple-docs servers. Grok's project config had the musterd server and not those three. The canonical skill was on disk. Nothing in `role assign`, `wire`, or `harness configure` equipped either of them.

## Problem

The association between a role and its equipment was recorded, and only one of the moments that provision a seat acted on it. A harness added after seat creation received the musterd fragments and not the role's toolkit. A role skill that was not a bundled built-in was never copied, and a bridge was written only when reconcile planned one, which it does not do for a harness whose binary is not installed. The other harnesses musterd supports were left to notice the gap by hand.

## Decision

1. One helper equips a seat's held roles into every harness in the Workspace's desired set. Seat creation, `role assign`, `wire`, and `harness configure` call it. `init` keeps provisioning the one toolkit the human picked, through the same toolkit writer, then the shared equip merges the role toolkits into that record.
2. An explicit `--profile` is the recorded toolkit name, and it is equipped. When `--profile` is omitted and nothing usable is recorded yet, the recorded name is the first held role's toolkit that loads. `generalist` and an empty name are skipped. A role file with no `toolkit` field, whose same-name toolkit does not load, is a label and is skipped quietly. A role file that names a toolkit which does not load is reported. Equipping provisions the union of the recorded toolkit and every held role's loaded toolkit, additively, into every desired harness. `--profile` does not suppress the role's toolkit. A failure is one outcome per harness and does not fail the caller. This extends ADR 708 decision 4.
3. `role assign --remove` lifts the permission ceiling (ADR 261) and does not call harness unprovision. When the recorded toolkit equals the removed role's toolkit and no remaining role names it, the recorded name is cleared and the command says the servers stay until `musterd uninstall --role-tools`. Skill bridges are not deleted (ADR 586).
4. Before reconcile, a missing skill that is a bundled built-in is installed and never overwritten. Bridges for claude-code, cursor, and grok stay the reconciler's `role-skill.*` fragments. When reconcile leaves a bridge absent, equip writes that same bridge. Codex and Muse read `.agents/skills/<skill>/SKILL.md` and get no bridge. OpenCode gets no skill file; a note names the canonical path only when a bridge was written. A missing skill that is not a bundled built-in is reported. `ios-engineer` stays unbundled.
5. Production `role assign` calls `reconcileHarnesses`, with a dependency injection so a test can stub it. A Workspace with no desired set is left unchanged.

## Consequences

- Assigning a role, wiring a folder, or changing the desired set equips the skill and the toolkit on the harnesses in that set. A harness whose binary is absent still receives the bridge file and the toolkit servers.
- Removing a role drops it from the recorded toolkit name when it was the only reason for that name. The servers remain until an uninstall. A later wire does not put them back from the recorded name.
- `init` still provisions the human's pick into the one harness it always has, then the shared equip fills the rest of the desired set.

## Observability & Evaluation

- Traces: provisioning stays a local act. The manifest's `role-tools` contribution names every server written per harness, and the command prints a line per harness that was written or that failed. No new daemon audit. No secret is logged.
- Eval: the dataset is the built-in `ios` toolkit plus a seat Workspace whose role names that toolkit and whose canonical skill is on disk. The baseline is the 2026-10-22 gap: desired `grok` had no Expo, XcodeBuildMCP, or Apple-docs server and no grok skill bridge. The tests assert those servers in grok, codex, opencode, and cursor, the muse settings write under `XDG_CONFIG_HOME`, the bridge file, and that `--remove` clears the recorded name without deleting the servers or the bridge.
- Experiment: none. The equip moments are this change.
- Falsifier: a Workspace whose role names toolkit `ios` and skill `ios-engineer`, with the canonical skill present, after `role assign` or `wire`, lacks those three servers in a desired file-writing harness, or lacks the grok, claude-code, or cursor bridge.
