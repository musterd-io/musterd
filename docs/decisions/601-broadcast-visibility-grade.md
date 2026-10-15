# 601 — The broadcast sees every DM except human to human, with recognisable secrets masked

- Status: accepted
- Date: 2026-10-15

## Context

ADR 136 graded observers at mint: `full` for the operator's own dashboard, `public` for a shared watch
link. ADR 594 (decision 2) made the broadcast seat `public` too: "A stream shows its audience team
traffic. It never needs DMs."

On 2026-10-15 nick asked for the opposite: the stream should show the coordination that happens in
DMs. Most of the team's work is agents handing off, asking and answering each other and the human,
and on a public-grade stream all of it is invisible. Asked what must stay off it, nick named two
things: DMs between two humans, and secrets. The design was brainstormed in chat and is written up in
[the spec](../superpowers/specs/2026-10-15-broadcast-visibility-grade-design.md).

## Problem

None of the three grades fits. `public` hides every DM. `team` shows DMs but hides confidential asks,
and shows human-to-human DMs. `full` shows everything, including human-to-human DMs. No grade masks
anything: nothing scrubs message text today.

Filtering in the page was considered and rejected: every DM and every unmasked secret would then
travel to a rented Fly machine and sit in a browser, one rendering bug from a public stream.

Found while designing this: a member's roster status line is their latest `status_update` whatever
it was addressed to, so a human-to-human DM sent as a `status_update` already shows on the
public-grade stream.

## Decision

1. **A fourth observer grade, `broadcast`.** It sees everything `full` sees except a message
   addressed to a member where both the sender and the recipient are human, non-observer members.
   Confidential asks are included. Service seats count as agents.
2. **The daemon enforces it**, in the two places a grade is enforced today: the live firehose
   fan-out and the `GET /messages` history read. The fan-out learns a `humanPair` flag from the send
   path; the history read gets a `broadcast` branch.
3. **Everything a `broadcast` reader receives is credential-scrubbed** with the existing
   `scrubCredentials` (ADR 445): message bodies, every string in `meta`, roster status lines, and the
   lane, goal and report text the page reads. Matches become `<redacted:kind>`; the rest of the text
   stays. The scrub happens on the way out, for that reader only; stored data and other readers are
   unchanged.
4. **The scrub catches what is recognisable, nothing more.** A secret written as prose is not
   caught. nick chose this over hiding any message that contained a match.
5. **Roster status follows the grade.** For `broadcast` and `public` readers, a member's status line
   comes from their latest `status_update` that is not a human-to-human DM.
6. **The broadcast mints `broadcast`.** `musterd broadcast` and `musterd stream start` ask for it;
   minting stays human-admin only (ADR 580). This replaces ADR 594 decision 2 for the broadcast seat.
   The `/live` watch link stays `public` and the dashboard stays `full`. _(Amended 2026-10-15: a watch link may now be
   shared at `broadcast` grade, `public` staying the default — ADR 616; see Consequences.)_
7. **`/broadcast` never mints for itself.** With no handed seat it shows the refusal and loads
   nothing, instead of falling back to a `full` seat.
8. **Unknown or missing grades read as `public`.** _(Amended 2026-10-15: "missing" means a connection with no grade at the fan-out; a NULL `observer_scope` stays `full` per ADR 136 — see Consequences.)_

## Consequences

- The stream shows the team's real coordination, which is what it is for.
- A human's DMs to an agent and an agent's asks to a human are public. A human who wants to say
  something privately says it to another human, or not on this team while the stream is live.
- A credential that is not shaped like one reaches the stream. The scrubber's rules are the
  boundary; adding a pattern to it (or a prefix to `TOKEN_PREFIXES`) widens what is masked.
- The public-grade status-line leak is closed for watch links as well.
- A `broadcast` seat is a stream's seat. Endpoints the page does not read are not scrubbed for it.
- Lanes: inc 2 `01M50C1T9P735H4Z4P7KW7XJX3` (server), inc 3 `01M50C1ZZMJFRG409G6TC4S303` (CLI and
  page). Until inc 3 ships, the stream keeps its `public` seat.

- **2026-10-15 — what decision 8 covers** (big-body's send-back of inc 2, lane
  `01M50C1T9P735H4Z4P7KW7XJX3`). Read literally, "missing → public" contradicts ADR 136's rule that a
  NULL `observer_scope` is `full`, which the v18 migration relies on (it set every pre-v18 observer
  to `full`, and every mint since writes an enum value). That reversal was not intended. What
  decision 8 means: an `observer_scope` string other than `full`, `public` or `broadcast` resolves
  to `public` wherever a grade is resolved (`resolveObserverScope`, feeding history, roster and
  masking), and a live connection with no grade is `public` at the fan-out. A NULL column stays
  `full`.

- **2026-10-15 — ADR 616 widens decision 6.** nick asked for demo audiences to see what the stream
  sees. A `/live` watch link now takes a grade when shared, `public` by default or `broadcast`, with
  one cached seat per grade; members with the guest role read at `broadcast` too. The stream's own
  seat and the dashboard are unchanged.

## Observability & Evaluation

- **Traces:** n/a — no agent-facing behaviour changes; this is a read filter on an observer seat.
- **Eval:** the grade matrix and masking tests named in the spec; the end-to-end check reads frames
  of a `musterd broadcast --out` run for a seeded human-to-human DM, an agent-to-human DM and a
  planted key.
- **Experiment:** n/a — the decision is a visibility rule chosen by the team's human, not a
  hypothesis to measure.
