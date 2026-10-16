# 614 — A message is not a dispute answer

- Status: accepted
- Date: 2026-10-15
- Deciders: nick ("take 01M4VEC15F", and "code matches SPEC" on the pin rule, 2026-10-15)
- Lane: `01M4VEC15FHN4JFJ1WA6PHTVBQ` (goal `memory-and-rules`)
- Builds on: ADR 434 (what discharges a directed act), ADR 476 (verify before conceding), ADR 484
  (the challenge-evidence rail), ADR 505 (one lifecycle for disputes)

## Context

The lane came from slippy, 2026-10-13. Given a review decline, slippy's first move was to tell
nick "concede to big-body" before re-checking the decline. Part of the decline turned out right
and part wrong. The lane asked where a concession gets past the rail, with three candidates:
(a) an `accept` on a review dispute, (b) a concession sent as a `message` or said in chat, and
(c) conceding to a human versus to an agent.

The audit, read off the laptop daemon on 2026-10-15 over the previous 30 days:

- **(a) is guarded, but the guard is off.** ADR 484's rail adds a one-line warning, never a
  refusal, to the sender of a check-less `accept` on any stamped dispute (ADR 505 §8). It ships
  behind team policy `challenge_evidence_rail`, default `false`. revive never set it: the
  `challenge.accept_unverified` audit row has 0 entries. It may not be needed. Of 11 `accept`
  answers to a dispute, 2 fail `namesCheck`, and both name a check that the pattern misses
  (`live38295938813`, `run38657232565`: CI run ids joined to a word). So 0 of 11 were really
  unchecked.
- **(b) is the leak.** 25 review rejections were stamped in 30 days. 10 were answered by
  `accept`, 7 by a `message` with `in_reply_to`, and 8 got no answer. 6 of the 7 messages concede
  ("Your decline is right", "Conceding your decline", "Agreed", "all three points land"). The rail
  never sees a `message`. ADR 505 §8's readout counts only `accept`/`decline`, so it reported 10
  answered when the real number was 16. A `message` also clears the pin: ADR 434 shape 3 discharges
  any obligation on the recipient's own reply by `in_reply_to`, whatever the act. That disagrees
  with SPEC §3, which says a server MUST pin a review dispute "until the owner replies `accept`
  … or `decline`". A message reply also skips ADR 505 §4's tiebreak route, so the hold it may
  carry is never judged. A concession said only in chat (slippy's case) is not an act at all.
- **(c) is not different in code.** `stampDispute` does not read the sender's kind: a human's
  review decline is stamped like an agent's. A human's critique in chat is (b) again.

## Problem

A concession costs nothing when it travels as a `message`. It clears the obligation, it is
recorded as neither a concession nor a hold, no rail sees it, and the readout undercounts the
team's answers by 6 in 16. The pin rule the SPEC states is not the one the code runs.

## Decision

1. **A review dispute stays pinned until an `accept` or `decline` answers it, or its thread is
   resolved.** The pinned-inbox SELECT (`listInbox`) gives the review-dispute clause ADR 434's
   shapes 1 and 2 only. The owner's `message` reply, shape 3 or 4, no longer clears it. The inbox
   response's `answered` list follows the same rule, so a client does not un-pin what the server
   pinned. This is the code meeting SPEC §3 as written. Every other obligation keeps all four
   shapes.
2. **A `message` replying to a dispute gets a notice on the sender's ack**, whatever
   `challenge_evidence_rail` says: `DISPUTE_MESSAGE_NOTICE` ("a dispute is answered with `accept`
   … or `decline` … A message records neither, and a review rejection stays pinned until one
   arrives"). It rides the existing
   `evidence_notice` field, which `team_send` and `musterd send` already render. It fires once per
   (sender, dispute), never for the dispute's own opener, and writes audit
   `dispute.message_answer` (actor = sender, target = dispute id). It is never stored on the act
   and never shown to the disputer, as with ADR 484 §2. The predicate is `isMessageDisputeReply`
   in `@musterd/protocol`.
3. **The readout counts the leak.** `DisputeCell` gains `message_only`: disputes whose only reply
   from the claim's side was a `message`. It is not part of `answered`, so ADR 505 §8's numbers
   keep their meaning. It defaults to 0, so a report from an older daemon still parses. Both
   loaders (`deriveDisputes` and `scripts/research/sycophancy-readout.ts`) also read `message`
   acts that carry `in_reply_to`. `musterd report` and the script print it only when it is
   non-zero.
4. **Guidance, v52.** The skill's dispute section adds that a `message` is not an answer, and that
   conceding to a human in chat before checking is the reflex the section exists to stop. That is
   the one place the chat-only case can be reached.
5. **Not in this ADR.** The rail switch stays off; whether to turn it on stays with ADR 476's
   thirty-day read on 2026-10-29, and this audit is evidence for that read. `namesCheck`'s miss on
   glued run ids is ADR 481's definition, so it is left alone and noted for that read.

## Consequences

- An owner who answers a review rejection with "agreed, fixing" in a `message` now keeps seeing
  the rejection pinned and is told why on the spot. The cost is one extra act per rejection, the
  `accept` or `decline` that should have been sent.
- `countOpenLoops`, the open-directed ledger and `answerBy` do not include review disputes, so
  wake and the open-loops gauge are unchanged.
- A dispute in a busy thread can no longer be cleared by the owner's chatter in that thread
  (shape 4). That was never an answer either.
- Follows-up: ADR 476's thirty-day read (2026-10-29) reads `message_only` beside `answered`, and
  decides the rail switch.

## Observability & Evaluation

- **Traces:** audit `dispute.message_answer` (actor, target = dispute id, detail `{ act }`, no
  body text); the readout's `message_only` per `via`.
- **Eval:** over the 30 days after this lands, the share of review rejections whose owner's first
  reply is a `message` (baseline 7 of 17 answered, 2026-10-15), and the share of
  `dispute.message_answer` notices followed by an `accept`/`decline` on the same dispute.
- **Experiment:** before and after, team-wide. No arm split: the pin change is a conformance fix
  and cannot be withheld from half the roster.
- **Falsifier:** if, 30 days on, `message_only` has not fallen below 3 of every 10 replied
  disputes, the notice is not moving behaviour and the next step is a refusal, which needs its
  own ADR.
