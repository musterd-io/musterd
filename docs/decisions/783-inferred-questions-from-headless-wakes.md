# 783 — Inferred questions from headless wakes: the host reports the last word, the daemon raises it

- Status: accepted
- Date: 2026-11-01

## Context

ADR 781 catches a question a seat ends its turn on, so it reaches `/live` and the phone. Its
catcher is Claude Code's Stop hook. A headless wake (`musterd host` on musterd-joiner-1, on Fly,
on the laptop) is where this matters most: nobody watches that terminal at all. ADR 781 left this
as 3c: "`musterd host`, for headless wakes, calls the same `inferQuestion` and gets the same
daemon rules."

The obvious build has the host send the ask itself, as the seat, the way the spend-approval hold
does (ADR 672). It cannot work. ADR 672's lease-only credential is accepted only while a fresh
Presence of the seat attests the wake's lease. The question is known only when the run has
**exited**, and the run's Presence goes with it. Every catch would be refused.

## Problem

1. A headless run that ends on a question raises nothing.
2. The host learns the run's last message only after the seat's session has ended, so it cannot
   act as the seat.
3. Only some harnesses print their last message where the host can read it.

## Decision

1. **The host reports the last word.** `WakeReportBodySchema` gains optional `final_message`
   (1–`WAKE_FINAL_MESSAGE_MAX` = 2,000 characters): the settled run's last assistant message. It
   rides the **supplementary** report, which the host already posts at settle on a lease the
   daemon already holds. The loop trims it and sends nothing when it is blank. A message over the
   bound keeps its **end** (prefixed `…`), because the question is at the end. Protocol schema
   change: additive, optional.
2. **The backends that can read it, read it.** `WakeCompletion` gains `final_message`:
   - **claude-code:** the `--output-format json` `result` of a clean run (`is_error: false`). A
     resume that fell back to fresh reports the last attempt that printed one.
   - **codex:** the text of the last `item.completed` item of type `agent_message` on
     `codex exec --json` stdout, on exit 0.
   - **opencode:** the text of the last `text` event's `text` part on `opencode run --format json`
     stdout, on exit 0.
   - **cursor-agent, grok, muse, native:** none yet. cursor-agent's result line has never been seen
     on a completed turn (`cursorUsage.ts`); grok and muse are not read from stdout at all. Their
     interactive turn ends are 3b's hooks (ADR 781).
3. **The daemon raises it as the seat.** On a supplementary report carrying `final_message`, for an
   occupied wake that did not yield (ADR 546: a person took the seat over, so they are at the
   terminal), `raiseWakeQuestion` runs `inferQuestion` (ADR 781 §1). On a match it composes, from
   the lease's seat:
   - an `ask`, species `consult`, to the team, with body the reported message;
   - `meta.question` `{ text, options?, context.lane?, inferred: true, audience: 'team',
     blocking: false }`, where `context.lane` is the lease's lane when it has one.
   It applies `checkInferredQuestion` first, so ADR 781 §3 holds unchanged: an agent seat only,
   and `409 question_already_open` while the seat has any open question. A refusal or failure
   raises nothing and never fails the report. Its response stays `cost_recorded`.
4. **The message is never logged or audited.** It is the one model-output field on the report.
   It is not copied onto `residency.wake_cost`. Its only home is the ask it raises.
5. **There is no withdrawal.** ADR 781 §4 withdraws a card when the person answers in the
   terminal. A headless run has no terminal and no next prompt. The card closes when it is
   answered, or with its lane.

## Consequences

- A headless seat that finishes on "Want me to open the PR?" puts a card on `/live` and the phone,
  with the lane it worked on attached. The answer wakes the seat (ADR 773).
- A headless Claude Code run whose workspace has the trace tap is caught twice: by its Stop hook
  (ADR 781 §2) and here. The hook's ask lands first, while the session is live, so the daemon's
  one-open-question rule makes this one a no-op. This is the double catch ADR 781's Consequences
  predicted.
- A host on an older build sends no `final_message`, so its wakes raise nothing until it updates.
  A daemon on an older build strips the unknown key (`WakeReportBodySchema` is not strict) and
  records the cost row as before.
- The codex and opencode event shapes are read from their documented `--json` writers, not from a
  captured run of this build. If they differ, those wakes raise nothing, and the Experiment below
  shows it.
- Follows-up: lane `01M67E83M9` (3b: OpenCode, Grok and Muse turn-end hooks) and lane `01M67EA48P`
  (3d: interactive Codex).

## Observability & Evaluation

- **Traces:** the raised ask itself, sent by the seat with `meta.question.inferred: true` and no
  session behind it. `team_report`'s question measures already count `inferred` (ADR 781). The
  host's `wake cost recorded` line is unchanged.
- **Eval:** `residency.test.ts` pins the bound. `residency-http.test.ts` pins a raise, and no raise
  for a statement, a yielded run, or a seat with a question already open; the audit row never
  holds the message. `loop.test.ts` pins the trim, the end-keeping clip, and no blank field. The
  backend tests pin each harness's parser.
- **Experiment:** over the next week, count inferred asks raised by agent seats while they had no
  live Presence (headless) against wakes that settled with an assistant message. **Falsify:** zero
  headless inferred asks from codex or opencode seats while those seats settled wakes, which would
  mean the event shapes in §2 are wrong for the installed builds.
