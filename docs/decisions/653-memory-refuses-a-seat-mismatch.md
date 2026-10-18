# 653 — Memory refuses a seat mismatch

- Status: accepted
- Date: 2026-10-17
- Lane: `01M561Y23A` (goal `security`)
- Design: `docs/design/seat-memory-isolation.md`, laptop tier item 3
- Relates to: ADR 093 (seat memory), ADR 442 (the wall), ADR 651 (who reads a note)

## Context

The CLI acts as the seat whose folder it runs in (ADR 442 decision 6: identity is the Workspace
binding, or nothing). On a laptop every seat's folder sits side by side under the roster home, and
an agent's shell can `cd` into any of them. So an agent launched as seat A that runs
`musterd memory` inside seat B's folder reads and writes **B's** note. The design names this the
most likely accident on a laptop. It was reproduced while building this lane: a session holding
`lazara` ran `musterd memory show` from `nick`'s folder and printed nick's note.

ADR 442 closed `--as` and the global-config fallback, so a folder with no binding resolves to
nobody. It did not cover a session standing in **another seat's** bound folder, because that folder
resolves correctly. It resolves as the wrong seat for the session running the command.

ADR 651 decides who may read a note. It works at the server, on the identity the request carries,
so it cannot see this case either: the request carries B's own credential.

## Problem

`musterd memory` has no way to tell "B's session in B's folder" from "A's session in B's folder".
Both present B's binding.

## Decision

1. **The session's own seat is the bound folder whose captured session slot names it.** Every seat
   folder's `binding.json` records the harness session that holds it (`session.id`, ADR 131 §5).
   When the running process carries the harness session id (`CLAUDE_CODE_SESSION_ID`), the CLI looks
   for the seat folders on this machine whose slot names that id and has not ended. It looks in the
   folders the global registry records (ADR 020) and in the siblings of the current Workspace.
2. **A mismatch is refused.** Before any request, every `musterd memory` subcommand (`show`,
   `show --seat`, `save`, `clear`) checks the seats that slot search found. If one of them is not the
   folder's seat, the command exits 5 (`forbidden`). The message names both seats and the session's
   own folder. Nothing is sent.
3. **An unknown session passes.** When there is no session id, or no slot names it, nothing says the
   session belongs anywhere else, so the command proceeds as before. An env identity
   (`MUSTERD_CLAIM`: service homes, tests) was chosen on purpose and is not checked.
4. **MCP needs no check.** The `team_memory_*` tools take no folder: the adapter acts as the binding
   of the folder its harness launched it in, which is the session's own seat by construction.

## Consequences

- The accidental half of path 4 in the design is closed for Claude Code sessions, which are most
  agent seats on this team. The CLI already has every input it needs, because the SessionStart hook
  writes the slot, so there is no protocol or server change.
- **Harness coverage is what the harness exposes.** Only Claude Code hands its session id to the
  processes it spawns. Codex, Cursor, Grok and OpenCode sessions carry no id here, so the check
  passes for them. That is recorded in `04-cli.md`, not implied.
- `musterd status` and `musterd claim` still print the folder seat's headline line (ADR 093 §3).
  This ADR covers the note's read and write commands only.
- This is a guard against mistakes, not a boundary. A process that wants B's note can unset the
  variable, or read B's credential directly. ADR 442's closing paragraph still holds: a hostile process
  under the same OS user is credential custody's to stop (ADR 200, ADR 341, and the hosted tier in the
  design).
- Lane 3 (the writer stamp and the suspect-note warning) is the other half of "a note knows who
  wrote it". It makes a write that gets past this check visible on read.

## Observability & Evaluation

- **Traces:** n/a — the refusal is a local CLI exit before any request, so no daemon row records it.
  The exit code (5) and message are the signal.
- **Eval:** `memory.test.ts` covers refusal (sibling and registry lookup, exit 5, both seats named)
  and every pass case (own session, unknown session, ended slot, env identity, no id). The lane's
  smoke run reproduced the accident from `nick`'s folder before the fix, and the refusal after it.
- **Experiment:** n/a — a deterministic guard with no tunable threshold.
