# 654 — A note says who saved it

- Status: accepted
- Date: 2026-10-17
- Lane: `01M561Y8QF` (goal `security`)
- Design: `docs/design/seat-memory-isolation.md`, laptop tier item 4
- Relates to: ADR 093 (seat memory), ADR 366 (memory replication), ADR 522 (claims checked on read),
  ADR 651 (who reads a note), ADR 653 (memory refuses a seat mismatch)
- Protocol: adds `MemoryWriterSchema` and `MemoryProvenanceSchema`, and optional `provenance` on the
  wake packet's `context.memory` (SPEC A.10). Feature epoch 35.

## Context

A seat's note is the first thing its next session reads, so a note written by the wrong session can
steer that session's work. That is pollution. On a laptop it cannot be stopped: every seat runs as
the same OS user, so any process can read another seat's `binding.json` and save as that seat. ADR
653 refuses the most likely accident, a session running `musterd memory` in another seat's folder,
for Claude Code. It cannot see a credential that was copied and used somewhere else.

Until now a save recorded only the seat (`continuity.memory_saved`, actor = the seat). Nothing said
which session wrote the note, so a polluted note read the same as the seat's own.

## Problem

What can the daemon honestly say about who saved a note? At the save, it knows the request's
session lease, which is bound to one Presence. That Presence was claimed with a surface and a
Workspace label, both reported by the claiming client. It also knows its own node. It does not know
whether the process holding the lease is the session that claimed it: a replayed lease looks exactly
like the seat's own session.

So the daemon can tell "saved from somewhere else" apart from "saved from here". It cannot tell
"saved by this seat's own session" from "saved by something holding its lease".

## Decision

1. **Each save stamps where it came from.** `PUT /teams/:slug/memory` records a writer stamp:
   `{surface?, workspace?, node?, machine?}`. The surface and Workspace label come from the Presence
   behind the session lease. The node is this daemon's node, and its label is the machine name. A
   human credential has no lease, so its stamp carries the surface header and the node only. The stamp
   is stored in `seat_memory.writer` (migration v107). It also rides the replicated
   `continuity.memory_saved` row, and the fold writes it through, so a second machine knows where the
   note was saved.
2. **Every read says who saved it.** The note's reads return `provenance: {writer, suspect, line}`:
   `GET /memory`, its `?envelope=1` form, and the wake packet's `context.memory`. `line` is one
   sentence: "last saved from `<folder>` on `<machine>` by `<surface>`". A save made before this ADR
   reads "who saved this note was not recorded", never as suspect.
3. **A note from another place is suspect.** On an **agent** seat's note, the reader's own place is
   compared with the writer's. The reader's place comes from the reading request's own lease. The
   note is `suspect` when it was saved from another folder or on another node. The folder is the
   Workspace label before its `@`, so a branch change or a new session in the same folder is the same
   place. A suspect line names both places and tells the seat to read the note as suspect and check
   its claims before acting on them. ADR 522's checks then limit what a polluted claim can do.
   _(Amended 2026-10-18: a writer with no folder, read by a session that has one, also counts as
   another folder. See Consequences.)_
4. **No verdict where the rule does not apply.** A human seat's note gets the fact and no verdict,
   because ADR 366 carries a human's notes across that human's machines on purpose. So does a read
   whose own place is unknown, and the ADR 651 human read of an agent seat's note
   (`GET /members/:name/memory`): that reader is not the seat.
5. **Not suspect never means verified.** No surface prints "trusted" or "verified". The stamp is
   what the saving client reported, and a replayed lease looks like the seat's own session.
6. **Where it is shown.** `musterd memory show` prints the line above the checks: a `⚠` warning when
   the note is suspect, a plain line otherwise. `team_memory_read` prints it under the headline. The
   SessionStart orientation adds one fixed sentence when the note is suspect. It never prints the
   folder or machine name there, because those labels are client-reported free text, and the
   orientation carries none (ADR 088's composable-only bar).

## Consequences

- Pollution through a credential used from another folder or machine stops being silent, on every
  harness. ADR 653 only covers Claude Code, but this works on every harness because the stamp is
  taken by the daemon.
- **It is visible, not prevented.** A suspect note is still delivered, because the seat's own note is
  its continuity and withholding it would break the next session. A lease replayed from the seat's own
  folder is invisible to this rule. Closing that is the hosted tier's job, with one OS user per seat.
- **Protocol.** The wake packet schema is strict, so an adapter built before this ADR refuses a new
  daemon's wake packet that carries a note, until that workspace is rebuilt. Feature epoch 35 makes
  such a seat show as behind on the roster. `GET /memory` and its envelope form are not
  schema-checked by the clients, so older clients ignore the new field. `MemoryEnvelopeSchema` (the
  `occupied` frame) is unchanged.
- **Replication.** An older peer that folds a stamped row ignores `writer`. A newer peer that folds an
  older row stores no stamp, which reads as "not recorded".
- **ADR 651 holds.** `redactedNoteDetail` drops the stamp along with the note, so another human's
  writer stamp is not shown either.

- **2026-10-18 — the canary found a way around decision 3** (lane `01M561YJYQ`). A session with
  no live socket loses its Workspace label on its next ordinary request, because the ambient touch
  rewrites the Presence row from the request, and a request names no folder. So an intruder that
  claimed a fresh lease from another folder could send one GET first, and its save then read "saved
  from an unnamed folder", not suspect. Decision 3 now treats a writer with no folder as another
  folder whenever the reader has one: a seat's own live session (the MCP adapter's socket) always
  names its folder, so a folderless save cannot be placed as the seat's own. A seat driven only
  through the HTTP CLI, with no socket, will see a false warning, which is the accepted cost. The
  same canary found that the wake-context route read the woken session's place after its own touch
  had erased it. The route now reads the place before it touches. The cause, an ambient touch that
  clears the label, is left as it is: that row also drives displacement and the roster.

## Observability & Evaluation

- **Traces:** the stamp itself is the trace. Every `continuity.memory_saved` row now names the
  saving surface, folder and node, so who wrote a note can be read back from `/audit` (subject to ADR
  651's read rule).
- **Eval:** `memory.test.ts` (server) pins the rule: not recorded, same place, other folder, other
  machine, human seat, unknown reader, missing workspace, and malformed stamps. `integration.misc`
  checks the save, both reads and the replicated row. `continuity.test.ts` checks that a folded note
  keeps the origin's stamp. The CLI `sessionOrientation` and MCP `resultAudit` tests cover the
  rendering.
- **Experiment:** n/a. The rule is deterministic, and its only threshold is "another folder or node".
  A false positive would show up as a suspect line on a seat's own note. Seats can report it, and if
  that happens the folder comparison is the place to narrow.
