# 773 — Question asks: a seat's question to a person, with options and no clock

- Status: accepted
- Date: 2026-10-30

## Context

nick drives about a dozen seats, and the laptop that hosts them is overloaded. Moving seats to an
always-on box (`musterd-joiner-1`) only helps if he can drive them without their terminals. What
pulls him back to a terminal today is a seat ending its turn on a question in chat: "re-run the red
shard, or fix the flake first?", with options or none. Those questions never reach `/live` or the
phone. What does reach them is the ADR 147 `ask`, which is mostly a yes/no approval with a tier
clock.

The design, approved by nick on 2026-10-30, is
`docs/superpowers/specs/2026-10-30-seats-ask-you-answer-design.md`. Its plan is
`docs/superpowers/plans/2026-10-30-seats-ask-you-answer.md` (lane `01M674N7XA`).

## Problem

1. **Options exist only as prose.** `/live` parses lettered lines out of an ask's body (`askChoices`,
   `packages/web/src/live/askPhrase.ts`). The result has no consequence per option and no "why",
   and the lane, PR or branch the question is about must be guessed from text.
2. **The tier clock does not fit.** ADR 147's tiers say how long the *agent* waits before it holds or
   proceeds (3, 5 or 15 minutes). A seat that asks a question has already ended its turn, so there
   is no waiting agent for a clock to govern, and a question answered after 15 minutes is still
   wanted.
3. **An answer is either a verdict or a chat message.** An answer is an `accept`/`decline`
   (approve/reject), or, from a channel, a `message` carrying `meta.channel_answer` (ADR 623). There
   is no shape for "option 2, and also ping big-body".
4. **Nothing wakes the asker.** `accept` and `decline` are not in `IDLE_RINGS` and are not wake
   reasons (`pendingInterrupts`), so an answer sits in the inbox until the seat is next prompted.

## Decision

1. **A question is an `ask` with `meta.question`.** `meta.species` is `consult`. `meta.tier` is
   **forbidden** on a question: the envelope rule that requires a tier exempts an ask carrying
   `meta.question` and refuses one that carries both. The no-answer machinery skips questions: no
   `ask_outcome`, no tier clock, no `deadline_ms` on the doorbell.
2. **The shape** (`packages/protocol/src/question.ts`):
   - `text`, 1–280 characters: the question;
   - `why`, optional, at most 600: why the seat is asking, in its own words;
   - `options`, 0–9 of `{ label (1–80), consequence? (at most 140) }`;
   - `context`, optional: `{ lane?, pr?, branch? }`;
   - `blocking`, default `false`: the seat cannot go on without the answer. This drives notification
     loudness, never a clock.
   - `audience`, default `'addressee'`: `'addressee'` means only the member named in `to` may
     answer; `'team'` means any human member may.
   - `inferred`, default `false`: set only by a fallback catcher that raised the question from a
     turn's last message (phase 3 of the design). An explicit question never sets it.
3. **Lifecycle, derived from the ledger.** A question is **open** until one of these:
   - **answered**: the first `accept` with `meta.in_reply_to` naming it and carrying `meta.answer`;
   - **withdrawn**: the asker sends `resolve` on its thread;
   - **lane closed**: when `context.lane` goes `done` or `abandoned`, the daemon writes a `resolve`
     on the thread with `meta.withdrawn: 'lane_closed'`.
     _(Amended 2026-10-30: derived on read from the lane's state, not written; see Consequences.)_

   An answer that arrives after a withdrawal is still recorded and delivered, with `late: true` in
   its proof, so the seat can ignore it. The first answer wins. A second is refused with
   `409 question_already_answered`, naming who answered and on which channel.
4. **An answer is an `accept`** with `meta.in_reply_to` and `meta.answer = { choice?, text? }`.
   `choice` is a 0-based option index (0–8); `text` is 1–4,000 characters. At least one is present,
   and both may be. `meta.answer` is valid only in reply to a question; a server refuses it on any
   other act or target. This holds on every channel. A question answer is not a verdict, so ADR 623's
   rule that a channel answer rides `message` and never `accept` keeps governing every non-question
   ask and does not apply here (decision 6).
5. **`meta.answer_proof` is server-controlled**:
   `{ channel: 'live' | 'app' | 'slack' | 'cli', verified, by, late? }`. A server strips a
   client-supplied copy, as it does `channel_answer`, and stamps its own from how the act arrived.
   ADR 774 says what `verified` means per channel and what it unlocks.
6. **A question answer authorizes nothing.** `answerAuthority` is `advisory` for every question
   answer (ADR 618, ADR 662). It is input to the seat. It never moves a lane, closes a gate or signs
   a privileged act. An `approve` species cannot carry `meta.question`.
7. **An answer wakes its asker.** An `accept` carrying `meta.answer` and `meta.answer_proof` is
   `idleRingable` for the asker (the open session's doorbell, ADR 558). It is also a wake reason on
   the immediate lane for a seat with no live presence (ADR 131). No lease is claimed for a seat that
   is live; its doorbell carries the answer instead.
8. **Delivery is confirmed.** An answer counts as delivered when the asker's adapter reports the
   inject (`idle_wake.injected`) or the host reports the wake lease that carried it. An undelivered
   answer is re-rung every 60 s, up to 3 times. After that, or after 5 minutes, it is flagged
   `undelivered` on every card that shows it. It is never silently lost.
9. **"Waiting on you" is derived.** A seat with an open question it asked shows `waiting`, not idle,
   on `/live` and in the roster. A person's list is the open questions they may answer (decision 2,
   `audience`).
10. **The tool.** The MCP adapter gains `team_question`. It sends the ask and **returns at once**,
    telling the seat to end its turn. Seats are told, in the role skills and the wake primer, to use
    it instead of ending a turn on a question in chat.

## Consequences

- `SPEC.md` gains A.31 (unreleased) with the shape and the rules above; `02-protocol.md`'s ask row
  names `meta.question` and `meta.answer`.
- `/live` stops parsing options out of a question's body. `askChoices` stays for ordinary asks.
- A question has one card. `deriveAsks` skips questions, and the triage view (plan Task 12) owns them.
- The ask tier contract is unchanged for every other ask, and so are their doorbell deadlines.
- A new `question_answers` table holds who answered, the channel, verification, lateness and
  delivery state. Its primary key on the question is what makes the first answer win.
- Phase 2 of the design (quick actions; PR-merged and CI-red events go to the seat) builds on
  decision 7's wake and is not part of this ADR.
- 2026-10-30 (lane `01M674NBRZ`): a question whose `context.lane` is `done` or `abandoned` reads as
  `lane_closed`. The daemon writes no `resolve`, because lanes close on four paths (a resolve, an
  acceptor's verdict, the acceptance sweep and the federation fold), and one read rule covers all
  of them where four writes would each be a place to forget. A `resolve` carrying
  `meta.withdrawn: 'lane_closed'` still reads as `lane_closed`.
- 2026-10-30 (lane `01M674NBRZ`), decision 8: re-offering an undelivered answer is the rails' own
  job. The idle seam raises the act again until the seat reads past it, and the immediate lane
  re-leases it. The daemon adds no separate 60 s re-ring; its sweep flags the answer `undelivered`
  at 5 minutes (`ANSWER_UNDELIVERED_MS`). `questionMeasures` computes the Experiment's numbers
  from `question_answers`. Surfacing them in `team_report` follows with the `/live` increment.
  Follows-up: lane `01M674NR7Q`.

## Observability & Evaluation

- **Traces:** audit actions `question.raised`, `question.answered`, `question.withdrawn`,
  `question.answer_delivered` (with `latency_ms`, from answer to delivery) and
  `question.answer_undelivered`. Text is never logged, only ids, channel and lengths.
- **Eval:** `question.test.ts` (shape, tier exemption, answer rules), `route.question.test.ts`
  (first answer wins, addressee rule, late answers, lane close), `residency.answer.test.ts` (an
  answer claims a lease only for a seat that is not live).
- **Experiment:** `team_report`'s `questions` block reports `asked`, `answered`,
  `answered_off_terminal`, `undelivered`, `unflagged_undelivered` and `resume_p50_ms`. Targets from
  the design: `resume_p50_ms` under 30,000 on the laptop and on the box, and `unflagged_undelivered`
  at 0. **Falsify:** over the first full week after phase 1 lands, either `resume_p50_ms` ≥ 30,000,
  or any undelivered answer without a card flag.
