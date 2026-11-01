# 781 — Inferred questions: the turn-end catcher

- Status: accepted
- Date: 2026-10-31

## Context

ADR 773 gave seats an explicit way to ask a person a question (`team_question`): a decision card on
`/live` and the phone, answered anywhere, and the answer wakes the seat. Seats are told to use it,
but a seat still often ends its turn on a question in chat ("Want me to start on this?"). That
question sits in a terminal nobody is watching. The design
(`docs/superpowers/specs/2026-10-30-seats-ask-you-answer-design.md`, §1, approved by nick
2026-10-30) asks for a fallback: the turn-end hooks look at the last assistant message, and if it
asks the person something, an ask is raised from it, marked `inferred` (ADR 773 §2 reserved the
field). This is phase 3a: the decision, the shared check, and Claude Code. OpenCode, Grok and Muse
(3b), headless wakes (3c) and interactive Codex (3d) follow on the same pieces.

## Problem

1. **Questions are lost.** A turn that ends on a question in chat raises nothing. The person sees
   it only if they return to that terminal.
2. **Each turn-end hook would otherwise decide for itself** what counts as a question, so the
   harnesses would drift apart.
3. **A catcher must not add noise.** It must not raise a second card beside an explicit question,
   must not stack a card on every turn of a long exchange, and must not leave a card open after the
   person has already answered in the terminal.

## Decision

1. **One check, in `@musterd/protocol`:** `inferQuestion(message)` (`question.infer.ts`) returns
   `{ text, options? }` or null. It is pure, so every catcher (hook, host) uses the same rule.
   - Fenced code blocks and quoted lines are removed first. The message must **end** on a question:
     the last paragraph's last sentence ends with `?`. A question in the middle of a message is
     not caught.
   - `text` is that sentence, with markdown emphasis removed, clipped to ADR 773's 280 characters.
   - **Options**, only for a choice: when the question says `which`, `pick`, `choose`, `prefer` or
     `or`, and the block just before it is a list of 2–9 items, each item becomes an option. Text
     after ` — ` or `: ` in an item is its consequence.
   - A yes/no offer (`Want me to…`, `Shall I…`, `Should I…`, `Do you want…`, `OK to…`,
     `Can I…`, `May I…`) gets the options `Yes` and `No`, so the phone can answer it from the lock
     screen.
2. **Claude Code: the trace tap carries it.** `musterd trace hook` already runs on `Stop` and on
   `UserPromptSubmit` (ADR 445), and ADR 558's turn markers ride it, so existing sessions need no
   hook reinstall. On `Stop`, with `stop_hook_active` false, the hook runs `inferQuestion` over
   `last_assistant_message`. On a match it sends, as the seat:
   - an `ask`, species `consult`, to the team, with body the last message clipped to 2,000
     characters;
   - `meta.question` `{ text, options?, inferred: true, audience: 'team', blocking: false }`. An
     inferred question is never blocking, so it never buzzes outside the person's preferences
     (ADR 779 §5).
   It is bounded by the hook's HTTP timeout and fails silently, like the rest of the tap.
3. **The daemon's rules for an inferred question:**
   - Only an **agent** seat may raise one (`forbidden` otherwise): a person's own session never
     asks that person.
   - It is refused, `409 question_already_open`, while the seat has **any** open question. An
     explicit question raised in the same turn therefore wins, and a long exchange holds one card,
     not one per turn.
4. **Answered in the terminal → withdrawn.** The hook writes the question's id and the session id
   to `.musterd/inferred-question.json`. On the next `UserPromptSubmit` in that session, it sends
   `resolve` on the question's thread (`meta.withdrawn: 'answered_in_session'`) and deletes the
   file. The person typed their answer where the question was asked, so the card leaves `/live` and
   the phone. A `resolve` after a card answer changes nothing (ADR 773 §3: the first close wins).

## Consequences

- A question a seat forgets to raise reaches `/live` and the phone. It is labelled inferred, so its
  thinner context (no `why`, no lane) and the miss itself are both visible.
- The check can be wrong both ways. It errs on the side of the turn's last sentence only: a question
  in the middle of a message is missed, and a rhetorical last sentence ending in `?` raises a card
  the person can dismiss. The rule is in one place, so it is tuned in one place.
- 3b (OpenCode `session.idle`, Grok and Muse Stop hooks) and 3c (`musterd host`, for headless wakes)
  call the same `inferQuestion` and get the same daemon rules. A headless Claude Code wake can then
  be caught twice, by its Stop hook and by the host. Rule 3's one-open-question refusal makes the
  second a no-op. Follows-up: lane `01M67E83M9` (3b), lane `01M67E9BGX` (3c), lane `01M67EA48P`
  (3d, interactive Codex).
- 2026-11-01: 3c is ADR 783. The host cannot act as the seat once a headless run has exited, so it
  reports the run's last message on the supplementary wake report and the daemon raises the
  question as the seat, under §3's rules.
- 2026-11-01: 3b is ADR 785. None of the OpenCode, Grok or Muse hook payloads carries the message, so
  each catcher reads it from the harness's session store. Grok and Muse have no prompt hook, so
  §4's withdrawal comes at their next tool call or turn end instead.

## Observability & Evaluation

- **Traces:** the ask itself, with `meta.question.inferred: true`. `team_report`'s question measures
  already count `inferred` (ADR 773 Consequences), so the share of questions the fallback caught is
  read there.
- **Eval:** `question.infer.test.ts` pins the check on real seat endings, including false cases (a
  question mid-message, a question inside a code block, a summary list before a yes/no offer).
  Server tests pin the two refusals; CLI tests pin raise-on-Stop and withdraw-on-next-prompt.
- **Experiment:** after a week, compare inferred with explicit questions in `team_report`.
  **Falsify:** inferred questions are more than half of all questions after the week, which would
  mean the explicit tool's guidance is not working and needs fixing at the seat, not here. Also read
  how many inferred cards were withdrawn unanswered against answered from a card: mostly withdrawn
  means the catcher is noise where the person sits at the terminal.
