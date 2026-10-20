# 684 — An ask that offers options in prose is told so when it is sent

- Status: accepted
- Date: 2026-10-20

## Context

/live renders an `ask` as option buttons only when its options are lines that start with a marker:
`A.`, `B)`, `(c)`, `1.` and so on. `askChoices` in `packages/web/src/live/askPhrase.ts` reads them
(lane 01M511XNQC). Any other ask gets Approve / Deny.

On 2026-10-20 schmidt asked nick: "Which account should hold the key: a new GCP project, an existing
one you name, or AWS once credentials are on this machine?" (01M5DDXVHY). That is three options in one
sentence, so nick got Approve / Deny, which answers none of them.

## Problem

The sender is the only one who can fix the format, and it found out only after the human did.
Nothing on the send path said the ask would not render as a choice. The parser is right to be strict:
lane 01M5AVXZ9B saw a looser reader turn a review's numbered findings into "pick one" buttons.

nick chose to fix this at the source rather than make /live read prose (2026-10-20, in session).

## Decision

1. `@musterd/protocol` gains `askProseChoiceNotice(body): string | null` in `ask.wire.ts`, beside
   `askContractText`. It returns a notice only when the body has no option line and reads as a
   choice:
   - a sentence with an interrogative (which / what / whether / should / shall / would you / do you
     want / prefer) and an "or", up to its "?";
   - inline markers joined by "or", as in "(a) revert, or (b) patch forward";
   - an "options:" or "alternatives are" lead-in.

   Inline markers that are not joined by "or" are a list to confirm, not a choice, and get no notice.
2. MCP `team_send` appends the notice to the reply for an `ask`, and sets `prose_choice_notice` in
   `structuredContent`. `musterd send` prints the same line.
3. The notice is advisory and computed client-side from the body. The daemon, the envelope and the
   wire are unchanged. Nothing is refused or rewritten. /live's parser is unchanged.

## Consequences

- The grammar now has two readers: `askChoices` renders it on /live, and `askProseChoiceNotice` warns
  about its absence. The second checks only "is there any option line", so it cannot disagree with the
  first about what counts as an option.
- Measured on the last 400 non-review asks in nick's local DB on 2026-10-20, the notice fires on 32 (8%).
  Read by hand, nearly all are real "X, or Y?" choices that Approve / Deny answers ambiguously, for
  example "Should I hand it to izzo, or can you name a route?". A first cut that also counted bare
  numbered lists fired on 45; it was narrowed before landing.
- An ask that is already out keeps rendering as Approve / Deny. The notice only helps the next one.

## Observability & Evaluation

- Traces: none new. The notice is part of the send reply the sender's transcript already holds.
- Eval: re-run the 400-ask sweep (`askProseChoiceNotice` over `messages` where `act = 'ask'` and no
  `lane_review`) after a week. If the share of new asks that are prose choices has not fallen, the
  notice is not changing how asks are written.
- Experiment: n/a. This is a one-line advisory, with nothing to arm or compare.
