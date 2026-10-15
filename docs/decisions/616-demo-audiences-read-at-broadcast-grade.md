# 616 — Demo audiences read at broadcast grade: a watch link can carry it, and guests read at it

- Status: accepted
- Date: 2026-10-15
- Lane: `01M50XJ5G7GS5HXQNVNDDVEC0Y` (goal `broadcast-shows-the-work`)
- Builds on: [ADR 601](601-broadcast-visibility-grade.md) (the `broadcast` grade),
  [ADR 136](136-observer-grades-public-watch-links.md) (observer grades, the watch link),
  [ADR 407](407-visibility-is-team-wide-delivery-is-addressed.md) (`team` grade, confidential asks),
  [ADR 128](128-recipient-scoped-message-reads.md) (party reads), [ADR 580](580-human-credentials-require-human-admin.md)
  (minting is human-admin only)
- Amends: ADR 601 decision 6, for the watch link only

## Context

ADR 601 made a fourth read grade, `broadcast`: everything `full` sees except a member-addressed act
whose sender and recipient are both human, non-observer members, with every string the reader gets
credential-scrubbed on the way out. It gave that grade to one reader, the stream. Decision 6 kept the
`/live` watch link `public` and the dashboard `full`.

On 2026-10-15 nick asked for the same view for demo audiences: "for demos and stuff, I want the
audience to see all messages/acts/asks except for human to human stuff", and then "guests should get
broadcast grade". A demo audience reaches a team two ways:

- **A watch link** shared from `/live`: a hidden, read-only observer seat (ADR 063), minted `public`
  today (ADR 136), cached once per team.
- **As guests**: the Cloud design's talk-only invite role (Cloud spec §4.6, lane `01M3Z42GN1`, not
  built yet). A guest is a Member that may send `message`, `status_update`, `request_help` and `ask`
  and answer threads addressed to it, and nothing else. The demo goal joins an audience this way, from
  the Claude app on their phones.

## Problem

Neither path gives the audience what nick asked for.

- A `public` watch link hides every DM and every ask to a member, so the coordination a demo exists to
  show is invisible.
- A guest is a non-observer member, so `messageVisibilityOf` (`store/rows.ts`) reads it at `team`
  grade (ADR 407). `team` shows **every** DM on the team, including the ones between two humans, and
  hides confidential asks. For a room of strangers on their phones that is both too much and too
  little: it shows exactly the human-to-human traffic nick wants kept off, and it scrubs nothing.

## Decision

1. **A watch link takes a grade when it is shared: `public` (the default) or `broadcast`.** The
   share control on `/live` asks, defaults to `public`, and says in one line what `broadcast` adds:
   agent DMs and asks; never a DM between two humans; keys masked. The link's page names its grade.
2. **One cached watch seat per grade.** A team keeps at most one `public` watch seat and one
   `broadcast` watch seat, each minted on first share of that grade. Sharing a public link never hands
   out the broadcast seat's credential, and revoking one grade's seat leaves the other.
3. **Minting is unchanged.** A watch seat is minted the way every observer is: by a human admin or the
   local operator (ADR 134, ADR 580), with `observer_scope` set to the chosen grade. A watch link
   never mints `full`.
4. **A member whose role is `guest` reads at `broadcast` grade.** `messageVisibilityOf` returns
   `broadcast` for a non-admin, non-observer member whose role ceiling is the talk-only guest role that
   Cloud increment 4 defines. Every other member keeps `team`; admins keep `full`.
5. **A guest is always a party to its own acts.** On top of the `broadcast` filter, a guest reads every
   act it sent and every act addressed to it (ADR 128's party predicate), including a DM between it and
   another human. The `broadcast` filter removes a human-to-human DM from every *other* broadcast
   reader; it never hides a guest's own conversation from the guest.
6. **The scrub covers a guest's reads.** Everything a guest reads (history, firehose, roster status
   lines) goes through the same `scrubCredentials` pass as a `broadcast` observer, on the way out, for
   that reader only.
7. **A guest counts as human** in ADR 601's human-pair test, because it is a member of kind `human`
   that is not an observer. A guest's DM to nick is therefore hidden from the stream, from broadcast
   watch links and from other guests.

## Consequences

- A demo works today with a `broadcast` watch link, once ADR 601's server increment (lane
  `01M50C1T9P`, #2684) is accepted: the room sees agent DMs and asks, never a human-to-human DM, and
  recognisable keys are masked. Guests read the same way once Cloud increment 4 exists.
- Guests see **less** than they would have by default. Without this decision they would have read at
  `team` grade and seen human-to-human DMs. They also see confidential asks, which `team` hides; that
  is the trade ADR 601 decision 1 made for the stream, accepted here for the same audience.
- An agent's answer to a guest's question is agent-to-human, so every other guest and the stream see
  it. A guest who wants to say something privately says it to a human; a human who wants to reply
  privately replies to the guest directly, and only the two of them see it.
- A secret written as prose still reaches the room (ADR 601 decision 4).
- `/broadcast` is unchanged: it still mints nothing and still refuses without a handed seat (ADR 601
  decision 7). The dashboard stays `full`.
- Lanes: `01M50XJDJ7` builds decisions 1–3 (watch link grade); `01M50XJJFE` builds decisions 4–7
  (guest reads) after Cloud increment 4 (`01M3Z42GN1`).
  Follows-up: 01M50XJDJ7SYH2RCFQR72PBBYE
  Follows-up: 01M50XJJFE7WC6E1Z126XG28Q9

## Observability & Evaluation

- **Traces:** n/a — no agent-facing behaviour changes; these are read filters on a watch seat and on
  the guest role.
- **Eval:** each build lane's done-when is the check. For the watch link: a `broadcast` link shows an
  agent-to-human DM and an agent-to-agent DM, and does not show a planted human-to-human DM or a planted
  key; a `public` link minted from the same team shows neither DM. For guests: a guest sees an
  agent-to-agent DM and an agent's ask to nick, does not see a DM between two other humans, sees its
  own DM to nick and nick's reply, and gets keys masked; a member-role seat's reads are unchanged.
- **Experiment:** n/a — a visibility rule chosen by the team's human, not a hypothesis to measure.
