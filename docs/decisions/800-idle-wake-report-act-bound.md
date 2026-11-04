# 800 — The idle-wake report names any act id

- Status: accepted
- Date: 2026-11-04

## Context

ADR 558 gave the idle-wake adapter an outcome report, `POST /teams/:slug/inbox/idle-wake`, parsed
through `IdleWakeReportSchema`. Its `act` field was capped at 40 characters. Every act id at the time
was a ULID (26) or a UUID (36), so the cap was never reached.

ADR 773 §8 later made that report the delivery signal for a question's answer: an `injected` report
writes `question_answers.delivered_at`. Lane 01M6HCD4YF (#3817) then made the idle seam stop
offering an answer once it is delivered.

The phone answers questions too (ADR 774). The daemon mints those answer ids as
`app-<ask id>-<ms>`, which is 44 characters (`appQuestion.ts`, `appAdapter.ts`). Envelope ids have no
upper bound (`envelope.ts`).

## Problem

Every `injected` report for an answer from the phone failed the schema with a 400. The adapter sends
the report fire-and-forget, so the failure was silent. The answer was never marked delivered, the
sweep flagged it undelivered at five minutes, and the idle seam offered it again and again. On
2026-11-04, all three of nick's phone answers to fifty's questions re-arrived 3–6 times each. The
daemon log showed seven 400s on fifty's reports in three hours while other seats' reports returned
200 (lane 01M6M3YYH5).

## Decision

`IdleWakeReportSchema.act` accepts up to 128 characters. That covers every act id the daemon mints
today, with room for a longer prefix. It still bounds a field that lands in the durable audit log.
Nothing else about the report changes: it stays strict, and it never carries the line or a body.

The other option was to mint app answer ids of 40 characters or fewer. That fixes the phone, but it
leaves the trap for the next id format, because envelope ids stay unbounded while the report is not.

## Consequences

- A phone answer is marked delivered on its first reported inject, and #3817's filter then stops it
  ringing. Answers already flagged undelivered stay flagged; they are past the sweep.
- An older adapter is unaffected: it sends the same shape. An older daemon still refuses ids over
  40, so a phone answer re-rings against one until it refreshes.
- `SPEC.md` (the idle-wake appendix) and `docs/architecture/02-protocol.md` name the bound.

## Observability & Evaluation

- **Traces:** `idle_wake.injected` rows now appear for app answers, and `question.answer_undelivered`
  should stop appearing for answers whose seat was live.
- **Eval:** `idle-wake.test.ts` covers a 44-character answer id: one raise, a 200 on the report,
  then silence. `idleWake.test.ts` covers the bound.
- **Experiment:** n/a — a schema bound, checked by the next phone answer to a live seat:
  `question_answers.delivered_at` should be set within seconds of the answer.
