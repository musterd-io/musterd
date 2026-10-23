# 721 — A human's own status line

- Status: accepted
- Date: 2026-10-22

## Context

nick, 2026-10-22: "humans should be able to set a 'status' or 'away message' … I (nick) want to set my
status to 'assembling a new dresser for the nursery' and i want this status to show on /live,
/broadcast. this should not just be a front end thing."

A Member already carries a self-set **availability** (`available | away | dnd | off_hours`, with an
optional `until`; ADR 044, SPEC A.6 Axis 2), set by the caller for their own seat only
(`POST /teams/:slug/availability`). It has no words: a teammate or a viewer can see that nick is away,
not what he is doing. The brainstorm with nick (the same day) fixed the rest:

- **Humans only.** Agents never have one.
- **Only the human it belongs to sets or clears it.** Not another human, not an admin, not an agent —
  and an agent cannot set its own, because agents have none.
- **48 characters at most**, so it reads at a glance on the stream.
- **It clears itself an hour after it is set.** Setting it again starts a new hour.
- **On /live and /broadcast**, as a second line of the member's nameplate: a footer washed with the
  member's own colour (option "A3" in the brainstorm), led by an hourglass ("glass and sand"). **On
  the team panel**, as a second line under the name.

## Problem

Where the words live, who may write them, how they expire, and how every surface learns of them —
without making the status a front-end decoration that one browser knows and the stream does not.

## Decision

1. **A Member gains an optional `status_line`**: `{ text, set_at, expires_at }`, `text` 1–48
   characters after trimming (counted in Unicode code points, so an emoji is one), `set_at` and
   `expires_at` in ms epoch with `expires_at = set_at + 3_600_000`. It is a protocol field on the
   Member as the roster carries it (`@musterd/protocol` `MemberSchema` and the roster summary),
   nullable, absent on every agent and service. The name is deliberately not "status": a member's
   presence and availability already use that word.

2. **Only the human it belongs to writes it, and the server enforces it.**
   `POST /teams/:slug/status-line {text}` sets it; `DELETE /teams/:slug/status-line` clears it. Like
   availability, the route carries no member name: it always acts on the authenticated caller. The
   server refuses (403, `status_line_humans_only`) unless the caller is a **human** Member signed in
   as **itself** — not an observer seat (ADR 063), not acting as another seat, not an agent
   session, not a wake lease (ADR 672). An admin has no override. Text over 48 code points, or
   empty after trimming, is a 400 that names the limit.

3. **Expiry is a read-time fact.** The stored row keeps `expires_at`; every read that builds the
   roster omits a `status_line` whose `expires_at` has passed, and the server clears the stored value
   the next time it writes that member. Surfaces also drop it at `expires_at` on their own clock, so
   an open /live tab or the stream clears it on the minute without a new event. Nothing sweeps.

4. **It is pushed, not polled.** Today an availability change pushes nothing: /live re-reads the
   roster on a `presence` frame or a 60-second poll, and /broadcast has no poll at all, so a status
   would reach the stream late or never. A set or clear therefore broadcasts a new team socket frame,
   `member_updated`, carrying that member's roster summary, and /live and /broadcast replace the
   member from it. (The frame is general on purpose; availability can ride it later, outside this
   ADR.) The `presence` frame keeps its meaning.

5. **On a team that spans machines, the hub's copy is the one shown.** A status set on a joiner's
   daemon is forwarded to the hub, as the style settings are (`/members/me/style`): the hub's value
   wins, and an unreachable hub refuses the set rather than keep a local copy the stream never sees.
   `expires_at` is the hub's clock.

6. **Where it is set:** the CLI (`musterd status-line "…"`, `musterd status-line --clear`, and the
   bare command prints the caller's own) and /live (the caller's own nameplate opens a small field).
   It is **not** an MCP tool: the tool surface is an agent's, and an agent can never set one.

7. **Where it shows:** the nameplate's second line on /live and /broadcast (the colour footer, the
   hourglass first), and a second line under the name on the team panel. **It shows on a folded
   nameplate too** (nick, 2026-10-22). Plates fold to dot and name when a member is idle or away (lane
   01M5G7A9H1, against crowding); a status is set exactly when its human is away, so it is the one
   extra that does not fold. A status lasts an hour and only a human can set one, so it cannot
   accumulate on the floor. /broadcast is public, so the
   words are public; the field's help text says so where it is typed.

8. **Audit:** each set and clear writes `member.status_line` (actor the member, result `ok`, detail
   `{ action: 'set' | 'clear', length }`). The words themselves are not copied into the audit log: a
   status is personal and meant to vanish in an hour. _(Amended 2026-10-22: the result is `allow`. See the amendment below.)_

## Consequences

- Additive on the wire: an older client ignores the field; an older daemon never sends one.
- `SPEC.md` gains the field and the two routes. On 2026-10-22 another lane holds `SPEC.md`
  (big-body, ADR 662 coverage); the SPEC edit lands in this ADR's first increment once that lane
  releases it, and until then this ADR and `02-protocol.md` are the record.
  Follows-up: `01M5JV0M5MG5T6QA44Q1W7RZN2`
- _2026-10-22 (increment 1)._ Decision 8's audit result is `allow`, not `ok`: the audit vocabulary is
  `allow | deny`, and `ok` does not type-check. The row is otherwise as decided — the length, never the
  words.
- _2026-10-22 (fix after increment 3)._ The protocol's hand-written roster guard
  (`readMemberSummary` in `guards.ts`, which /live reads through) had no branch for `status_line`,
  so a refresh dropped a human's status the daemon still held; only the `member_updated` push showed
  it. The guard now reads the field, and the guard/schema parity corpus carries it (#3242). No wire
  change: the schema already had the field.
- The figure work and this are independent: the nameplate is DOM over the office, not the rendered
  scene.

Increments (lane `01M5JV0M5MG5T6QA44Q1W7RZN2`):

1. Protocol and server — the field, the two routes and their refusals, read-time expiry, the
   `member_updated` frame, forwarding to the hub, the audit row; `SPEC.md` and `02-protocol.md`.
2. CLI — `musterd status-line`, with the refusal an agent seat gets in plain words.
3. /live and /broadcast — the nameplate footer and hourglass, the team panel line, the field on the
   caller's own nameplate, the local clock that clears it at `expires_at`.

## Observability & Evaluation

- **Traces:** the `member.status_line` audit rows (set and clear, with the text's length, not the
  text) and the 403 refusals in the access log.
- **Eval:** n/a — no agent-facing behaviour; agents cannot use it.
- **Experiment:** n/a — a product field nick asked for, not a hypothesis.
