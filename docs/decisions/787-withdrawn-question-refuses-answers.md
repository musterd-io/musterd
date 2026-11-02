# 787 — A withdrawn question refuses answers and leaves the phone

- Status: accepted
- Date: 2026-11-02

## Context

[ADR 773](773-question-asks.md) §3 says an answer that arrives after a question was withdrawn "is
still recorded and delivered, with `late: true` in its proof, so the seat can ignore it". The
musterd app (ADR 676, 772) keeps a list of the asks that reached it and re-sends on every open
(`redeliver`) and fetches each body it shows (`handleAppFetch`). Both read `liveAppAsks`, which
checks the ask's token, decision and digest, but not whether a question is still open.

Device tests on build 40, 2026-11-01: question 01M6CAKBHJYKG9A46Z28YGC3CQ was withdrawn with a
`resolve` ("decided"). Nine hours later the phone still listed it under "Waiting on you". nick
answered it, and the answer was recorded `late: true` and delivered to the seat, which had already
moved on. On 2026-11-02 big-body saw old test cards still on the list on build 41. fifty decided
the rule on 2026-11-02 (act 01M6DBK5TFX3VGWEP0Q43ANY74): a resolve withdraws a question, and an
answer to a withdrawn question is refused, audited, and never written as late.

## Problem

A withdrawn question keeps asking. The phone shows it as waiting, because the daemon still
treats it as live. A person spends attention answering it, and the seat receives an answer it has
to recognise and ignore. `late: true` records the mistake after the fact; nothing stops it.

## Decision

1. **A withdrawn question refuses answers.** When a question's state is `withdrawn` or
   `lane_closed`, the route refuses an answer with `409 question_withdrawn` on every channel
   (`/live`, CLI, app). Nothing is claimed, persisted or delivered. This supersedes ADR 773 §3's
   late answer. The refusal is audited as `question.answered` with `result: 'deny'` and
   `detail: { answer, channel, reason: <state> }`, the same row shape as an accepted answer.
2. **The phone's answer reports it.** `sendQuestionAnswer` maps the refusal to the reason
   `question_withdrawn`, beside `question_already_answered`.
3. **A question that is not open is not live on the phone.** `liveAppAsks` skips any question
   whose state is not `open`. That covers withdrawn, lane closed, and answered on another channel.
   It also spends the skipped question's token, so it stops counting against the re-send cap
   (`REDELIVER_MAX`). A re-delivery leaves it out, and a body fetch answers `null`, which the app
   already reads as `gone`. The app then drops the card and clears its notification (ADR 772). No
   withdrawal push is added: the next open or fetch is enough, and it needs no new frame.
4. **`late` stays in the schema.** `AnswerProof.late` and `question_answers.late` remain for
   answers recorded before this ADR. The server writes `late: false` from now on.

## Consequences

- A person can no longer answer a question the seat has stopped waiting on. A seat that wants an
  answer after withdrawing asks again.
- An app answer to a withdrawn question is refused `question_withdrawn` by the daemon after the
  relay has already returned 202, the same as `question_already_answered` today. The phone does not
  hear about the refusal. Its card disappears on the next open, because the fetch answers `null`.
- `liveAppAsks` now reads `questionView` once per question token it considers. The token query
  is capped at `REDELIVER_MAX` rows, and spent tokens leave it, so the cost stays bounded.
- SPEC.md's question section says the same thing, and ADR 773 §3 carries a dated amendment marker.

## Observability & Evaluation

- **Traces:** an audit row `question.answered` with `result: 'deny'` and `detail.reason` set to
  `withdrawn` or `lane_closed` for each refused answer. The existing `channel.sealed_delivered`
  rows stop appearing for withdrawn questions on re-delivery.
- **Eval:** `route.question.test.ts` checks that an answer after a `resolve`, and after a
  `lane_closed` withdrawal, is refused `question_withdrawn`, writes no answer, and leaves one deny
  audit row. `appAdapter.test.ts` checks that the phone's answer to a withdrawn question is refused
  `question_withdrawn`, its fetch answers `null`, and a re-delivery sends nothing for it.
- **Experiment:** on nick's phone, a `team_question` that the seat withdraws with `resolve` leaves
  "Waiting on you" the next time the app opens. Falsified if the card is still listed after an
  open with the daemon reachable.
