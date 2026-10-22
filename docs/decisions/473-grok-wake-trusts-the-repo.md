# 473 — A Grok wake passes `--trust` so the seat's project hooks run

- Status: proposed
- Date: 2026-09-29
- Lane: `01M3NNKDZCH2D0JTNZ7C1K5J5T` (goal `research-corpus`)
- Builds on: [ADR 352](352-grok-first-class-harness.md) §7 (the wake argv this adds a flag to),
  [ADR 445](445-agent-traces-captured-local-first.md) (the R1 tap that lives in the project hook file).

## Context

Grok discovers project hooks from `<project>/.grok/hooks/*.json` and does not run them until the
folder is trusted. The grant is one store, `~/.grok/trusted_folders.toml` (or `$GROK_HOME`), and it
gates hooks, repo-local MCP, LSP, project instructions, and project skills together. Global hooks
in `~/.grok/hooks/` are always trusted. Headless startup does not prompt: Grok's own guide says it
requires `--trust` or a prior grant, and until then project hooks are silently skipped.

The trust key is the git common-dir parent — the main checkout — not a linked checkout's path.
Measured 2026-09-29 against Grok 1.0.40 on this machine:

| trust store key                                      | `grok inspect` on the wanderer Workspace                         |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| none                                                 | `projectTrusted: false`, zero project hooks                      |
| `/Users/nick/musterd/revive/agents/wanderer`         | `projectTrusted: false`, zero project hooks                      |
| `/Users/nick/.musterd/runtime` (the common-dir root) | `projectTrusted: true`, six hooks from `.grok/hooks/musterd.json` |

`grok --trust` writes that common-dir key itself. The dogfood store still names the pre-move
checkout `/Users/nick/agents`, so every seat Workspace of the current repo is untrusted.

ADR 352 §7's wake is `grok -p <line> --cwd <workspace>` (resume adds `-r <id>`). That argv never
passes `--trust` and never prompts, so a wake loads only the global hooks. The lane records the
trace of that: grokbot's project file never ran — 42 tool calls, zero R1 rows — and the wake failed
presence attestation of its lease though the seat answered. The R1 tap, the interrupt, the gate, and
session capture all live in the project file. Repo-local MCP is behind the same gate.

`--trust` is absent from `grok --help` on 1.0.40. It is a real flag: `grok --trust -p` fails only
because `--single` wants a prompt, and `grok --cwd <workspace> --trust inspect` both loads the
project hooks and persists trust on the common-dir root.

## Problem

A Grok wake cannot record R1, and cannot run the hooks musterd installed for the seat, because the
argv never trusts the repo. The hooks file is present. Grok skips it.

## Decision

1. **Fresh and resume wakes both pass `--trust`.** The argv is `['--trust', '-p', line, '--cwd', workspace]` and `['--trust', '-p', line, '-r', sessionId, '--cwd', workspace]`. Still no `--yolo`, `--always-approve`, or `bypassPermissions`.
2. **The grant is Grok's.** musterd does not write `trusted_folders.toml`. `--trust` is what persists the common-dir key and what loads project hooks in the process that needs them. A wake of a seat workspace is that grant: the hooks in the file are the ones musterd installed.
3. **No help-text probe for the flag.** On the version that accepts it, `--help` does not advertise it, so a probe of the help text would skip the fix. A grok that rejects `--trust` fails the wake in the open. That is the visible failure; the silent skip is the bug this replaces.

## Consequences

- The first wake of an untrusted repo writes the trust store. Later Grok sessions in other checkouts of that repo load project hooks without a prompt, because the key covers the common dir, not one checkout.
- Trusting the common-dir root trusts every checkout of that repo for hooks, MCP, LSP, instructions, and skills. For the dogfood repo that is the seat surface. A wake whose Workspace is some other repo trusts that repo's root, which is the same grant an interactive `grok --trust` there would make.
- [ADR 352](352-grok-first-class-harness.md) §7's argv list is unchanged in `## Decision`. The flag is recorded in that ADR's Consequences.
- Interactive sessions that never wake still need a grant. `musterd init` does not write the trust store; the wake does, the first time it runs.

## Observability & Evaluation

- **Traces:** the spawn argv is the host log. After this lands, a Grok wake's args include `--trust`. R1 rows from a Grok seat are the evidence the project PostToolUse hook ran.
- **Eval:** `grok inspect --json` in a seat Workspace, after one wake has run there, reports `projectTrusted: true` and at least one hook whose source type is `project` and whose command contains `musterd-grok-interrupt`. _(2026-10-22, ADR 718.)_ That marker now lives on the global hook. A project hook whose command contains `musterd-grok-gate` is the project-file stand-in. Falsifier: a wake on Grok 1.0.40 whose inspect afterwards still shows `projectTrusted: false`, or a session with tool calls and zero `PostToolUse` rows whose project hook file was present.
- **Experiment:** none. The trust-key table above is the measurement; withholding `--trust` from an arm would reproduce the zero-R1 wake this lane exists to close.
