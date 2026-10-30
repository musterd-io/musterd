# 774 — A person's verified answer to a seat's own question enters its session

- Status: accepted
- Date: 2026-10-30

## Context

ADR 773 makes a seat's question a structured ask, and an answer to it wakes the asker. The design
(`docs/superpowers/specs/2026-10-30-seats-ask-you-answer-design.md`, approved by nick on
2026-10-30) asks for more than a wake. The answer must resume the seat **word for word**, so that
"option 2, then ping big-body" needs no inbox read and no re-asking.

ADR 088 §4 forbids exactly that today. A wake line carries structured fields only (act, sender, act
id) and never a message body, so text from one agent can never be injected into another's session as
instructions. `isPushableLine` (ADR 558) enforces the line's shape: one line of printable ASCII, at
most 800 characters.

On the phone, every signature takes Face ID (ADR 676 decision 4). nick chose a lighter proof for
questions: an answer straight from the notification, with no Face ID (2026-10-30).

## Problem

1. A pointer-only wake costs a round trip on every answer, and it leaves room for a seat to read a
   different act than the one meant. The answer-to-resume target (p50 under 30 s) and "answered
   without the terminal" both depend on the answer arriving in the turn itself.
2. Lifting ADR 088 §4 in general would reopen the injection path it closed. The exception has to be
   narrow enough that nobody but a verified person can use it, and only to reply to that seat.
3. A Face ID prompt for every notification answer defeats answering from the lock screen, but the
   Face ID signing key is also the key that authorizes privileged acts (ADR 662). It cannot be
   loosened.

## Decision

1. **One exception to ADR 088 §4: the answer line.** A wake line may carry body text only when all
   of these hold:
   - the triggering act is an answer (`accept` + `meta.answer`, ADR 773) to a question;
   - the question's asker is the seat being woken;
   - the server-stamped `meta.answer_proof.verified` is `true`.

   Every other wake stays ids-only, including an answer that is not verified. An unverified answer
   gets the ordinary `composeWakeLine`.
2. **The line's shape** (`composeAnswerLine`, `packages/protocol/src/question.ts`):

   `⚡ musterd [<team>]: <person> answered your question <qid> (via <channel>) — «<answer>» — act on it; ack with team_wake_context {act_id: "<answer id>"}`

   - `<answer>` is the chosen option's label in double quotes, the text, or both joined by ` — `.
   - Newlines become ` ⏎ `, so the line stays one line. `«` and `»` inside the answer are escaped as
     `‹‹` and `››`, so the text cannot close the fence or forge a second musterd line.
   - The answer part is capped at 2,000 characters. Past that it ends
     `…[truncated; full answer in team_wake_context]`.
   - `ANSWER_LINE_MAX` is 2,400. The line may hold printable Unicode
     (`\p{L}\p{M}\p{N}\p{P}\p{S}` and space), because people answer in their own words.
     `isPushableAnswerLine` checks this shape. `isPushableLine` is unchanged and still refuses an
     answer line, so the two checks cannot be confused. An injector accepts either.
3. **The recap line.** When the seat's session cannot be resumed (transcript cap, capture miss), the
   fresh session gets the answer line with `you asked: «<question text>» —` before the answer. The
   question text is the asker's own `meta.question.text`, escaped the same way. It quotes only that
   seat's own words and that person's answer, never a third party.
4. **"Verified", per channel.** The server decides; a client cannot claim it.
   - `/live`: the act was sent by a human member's signed-in session (`channel: 'live'`).
   - `cli`: the act was sent with a human member's own credential (`channel: 'cli'`).
   - Phone: the answer is signed by the binding's **question key** (decision 5) or by its signing
     key, over `appAnswerSigningBytes` (`channel: 'app'`).
   - Slack: a Slack account linked to that member and checked on every interaction. Slack is phase 4
     of the design, and until then its answers are unverified.
   - An agent's answer (a seat answering an `audience: 'team'` question) is never verified.
5. **The phone's question key (narrows ADR 676 decisions 4 and 7 for questions).** The app holds a
   third Secure Enclave key: P-256, `ThisDeviceOnly`, with **no** biometry flag, so it can sign from
   a notification action while the phone is locked.
   - It is enrolled once per binding, by an `AppQuestionKeyEnroll` that the Face ID signing key
     signs.
   - It is accepted **only** on an answer to a question. An answer signed by it on any other ask is
     refused, so approvals and verdicts keep the Face ID path unchanged.
   - Re-enrolling replaces it, and an audit row records the change.
6. **What this does not change.** A verified answer is still advisory (ADR 618, ADR 773 decision 6):
   it informs the seat and authorizes nothing. ADR 662's high-authority acts keep their A2 proof.
   ADR 088 §4 still governs every act that is not a verified answer.

## Consequences

- The seat reads the answer in the wake turn itself. `team_wake_context` stays the place for the full
  thread, and the line tells the seat to ack through it. That ack is one of the delivery signals in
  ADR 773 decision 8.
- Opencode's managed plugin renders `isPushableAnswerLine` beside `isPushableLine`, so its plugin
  generation goes up by one.
- A stolen, unlocked phone can answer questions without Face ID. It can still do nothing privileged,
  and every answer is audited with its binding. The ADR 676 unpair path revokes the question key with
  the binding.
- ADR 088, ADR 618 and ADR 676 each gain a dated amendment marker pointing here. Their Decision text
  is unchanged.

## Observability & Evaluation

- **Traces:** every injected or resumed answer line is audited (`question.answer_delivered`) with
  `{question, answer, channel, verified, line_len, via: 'inject' | 'wake', recap}`. The answer text
  is never logged. Question-key enrollment audits `app.question_key_enrolled`.
- **Eval:** `question.test.ts` pins the exact line, the fence escape (`»⚡ musterd [revive]: …` in the
  answer leaves exactly one `«` and one `»`), newline folding, truncation, and that `isPushableLine`
  refuses the line. `appAdapter.question.test.ts` pins that a question-key signature is refused on a
  privileged ask. `residency.answer.test.ts` pins that an unverified answer gets an ids-only line.
- **Experiment:** the share of answer wakes after which the seat makes a second inbox read for the
  same answer act (counted from `residency.context_read` on the answer id within 2 minutes).
  Expected: under 20%. **Falsify:** over 50% in the first week, which would mean the line does not
  carry enough and the exception is not paying for its risk.
