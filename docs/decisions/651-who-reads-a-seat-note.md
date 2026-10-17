# 651 — Who reads a seat's note

- Status: accepted
- Date: 2026-10-17
- Supersedes in part: ADR 093 §Decision "Readable by the seat itself and the platform operator only"
  (for agent seats); amends the consequence of ADR 366 decision 2 on the read side
- Lane: `01M561XY7H` (Goal `security`); design: `docs/design/seat-memory-isolation.md`

## Context

ADR 093 made a seat's note readable by that seat only, "team admins included". ADR 366 then made
every save write a replicated `continuity.memory_saved` audit row carrying the headline and body,
because that row is how a human's note reaches their second machine. `GET /audit` returned that
row unredacted. So, in practice, any human admin could read any seat's note, including another
human's. That contradicts ADR 093.

On 2026-10-17 nick set the rule the design brainstorm (lane `01M3WJYDRN`) had asked for: **humans
see everything except another human's personal stuff.** An agent's note is team-visible to humans,
and a human's note is theirs alone.

## Problem

Two surfaces disagreed with that rule:

- `/audit` exposed a human's note to every other human admin.
- No route let a human read an agent seat's note. The only way in was to dig through `/audit` as
  an admin.

## Decision

1. **The read rule.**
   - An **agent** seat's note can be read by the seat itself and by **any human** on the team.
   - A **human** seat's note can be read by that human only. Not another human, not an admin, not
     an agent.
   - A seat the team no longer knows is treated as a human's, so a removed person's note never
     resurfaces.
   - No agent reads another seat's note.

   The rule lives in one function, `mayReadNote`, in `store/memory.ts`. Every cross-seat read uses
   it.
2. **`/audit` applies the rule on read.** For a `continuity.memory_saved` row the caller may not
   read, `detail` becomes `{ headline_len, body_len, saved_at, redacted }`. The stored row is
   unchanged: it is the replicated event (ADR 366), and redacting it on write would break a human's
   continuity across their own machines. `musterd audit` and the web audit page render whatever the
   server sends, so they follow the rule without changes.
3. **A human reads an agent's note by name.** `GET /teams/:slug/members/:name/memory` is
   human-authenticated and returns `{ member, headline, body, saved_at, checks }`. It refuses a
   human seat other than the caller's own with `403`. The CLI form is
   `musterd memory show --seat <agent>`. `GET /memory` stays the caller's own seat only.

## Consequences

- ADR 093's "admins included" now covers human seats only. For agent seats, Decision 1 above
  replaces it.
- **Out of scope.** Replication still carries every note to every enrolled machine, in plain text.
  Someone who can open that machine's database can read a human's note there. Encrypting human
  notes to their owner's machines is lane `01M561YWP0`, before launch. This ADR fixes the API, not
  the files.
- Agents can still reach notes outside the API on a laptop: through the database file, or with a
  sibling seat's credentials. Lanes `01M561Y23A`, `01M561Y8QF` and `01M561YQN3` address that.
- `/audit` makes one extra roster read, and only when the page holds a `continuity.memory_saved`
  row.

## Observability & Evaluation

- **Traces:** none new. `/audit` itself shows which rows were redacted, through the `redacted`
  field.
- **Eval:** `transport/integration.misc.test.ts` "who reads a note …" runs every case on both
  drivers: a human reading an agent's note, another human (the admin) refused a human's note, the
  owner reading their own, agents refused, `/audit` redacting the human row, and the stored row
  keeping its body.
- **Experiment:** n/a. A deterministic access rule, verified by the canary in lane `01M561YJYQ`.
