# 785 — Inferred questions on Grok, Muse and OpenCode: read the last message from the session store

- Status: accepted
- Date: 2026-11-01

## Context

ADR 781 catches a question a seat ends its turn on and raises it as an inferred question, so it
reaches `/live` and the phone. Its first catcher is Claude Code's Stop hook, whose payload carries
the turn's `last_assistant_message`. ADR 783 added headless wakes. ADR 781 left the interactive
turn ends of OpenCode, Grok and Muse as 3b.

Each of the three already runs musterd at a turn's end:

- **OpenCode:** the doorbell plugin runs `musterd trace hook --kind Stop` when a session goes idle
  and `--kind UserPromptSubmit` when it goes busy. That is the ADR 781 catcher's own path. But the
  plugin sends only `{session_id, hook_event_name}`, so there is no message to judge.
- **Grok:** the global Stop hook pipes its payload to `musterd inbox --interrupt-check --hook grok`
  (ADR 370). Its PreToolUse hook runs the same probe.
- **Muse:** the project Stop hook pipes its payload to `musterd inbox --interrupt-check --hook muse`
  (ADR 619).

None of the three payloads carries the message. Each harness writes it to its session store before
the hook runs:

- **Grok 1.0.70:** `updates.jsonl` has the turn's `agent_message_chunk` updates before the `stop`
  `hook_execution` record.
- **Muse 1.4.14:** `session.jsonl` has `assistant_message_committed` (with `text`) before
  `hook_run_started` for Stop.
- **OpenCode 2.2.2:** `opencode.db` `session_message` has the assistant row, with its parts inline
  as `data.content` and `finish: "stop"`, before the session goes idle.

All three were read on this laptop's own sessions on 2026-11-01.

## Problem

1. A Grok, Muse or OpenCode seat that ends its turn on a question raises nothing.
2. The hooks that run at those turn ends do not carry the message.
3. Grok and Muse have no hook on the person's next prompt, which is where ADR 781 §4 withdraws the
   card.

## Decision

1. **The message is read from the harness's session store, at the hook.** The readers are in
   `trace/lastMessage.ts`. Each reads only the end of the file (512 KB). Each returns nothing unless
   the turn ended on prose:
   - **Grok:** the trailing run of `agent_message_chunk` text in `updates.jsonl`. Thought chunks
     and hook records may sit after it. A tool call, a prompt or any other update ends the run.
   - **Muse:** the last `assistant_message_committed` in `session.jsonl`, unless an
     `assistant_tool_calls_committed` or a `runtime.user_intent.accepted` comes after it. A payload
     `last_assistant_message`, if Muse sends one, wins. The session is the payload's `session_id`
     (or `sessionId`), else `MUSE_SESSION_ID`.
   - **OpenCode:** the session's last assistant `session_message`, when its `finish` is `stop` and
     it has no tool part. Where `session_message` is missing (OpenCode 1.x), the v1 `message` and
     `part` tables are the fallback.
2. **The same check and the same rules.** Every reader feeds ADR 781's `inferQuestion`, and the ask
   it raises is §1's, under §3's daemon refusals. No protocol change.
3. **Where each catcher runs:**
   - **OpenCode:** on the trace tap, as Claude Code's does. The plugin is unchanged.
   - **Grok and Muse:** on the interrupt probe their Stop hook already runs. Neither hook is
     reinstalled.
   - The probe catches only when it printed no interrupt line. A printed line blocks the stop, so
     the turn goes on and its last message is not the last. It also skips a re-entered stop
     (`stopHookActive` / `stop_hook_active`) and a Grok stop whose `reason` is not `end_turn`.
4. **Withdrawal at the next boundary, where there is no prompt hook.** OpenCode withdraws on busy,
   which is ADR 781 §4's prompt. Grok withdraws at its next PreToolUse or its next turn end in that
   session. Muse withdraws at its next turn end. Each is the first musterd process to run after the
   person answered. The withdrawal is sent before that turn's own message is judged. So a long
   exchange keeps at most one card, and it is always the latest one.
5. **The ordinary tool call pays nothing.** On Grok's PreToolUse, the probe loads the catcher only
   when `.musterd/inferred-question.json` exists.

## Consequences

- An interactive OpenCode, Grok or Muse seat that finishes on "Want me to open the PR?" puts a card
  on `/live` and the phone.
- On Grok and Muse a card lasts until the seat's next action, not until the person's next
  keystroke. A person who answers in the terminal sees the card go when the seat starts on the
  answer, seconds later.
- Each reader depends on a harness's private store format, so a harness update can silence it. A
  silenced reader raises nothing and breaks nothing. The Experiment below is how it is noticed.
- OpenCode 2.x moved its store from `message` and `part` to `session_message`. The R2 transcript
  tail (`trace/opencode.ts`) still reads only the v1 tables, so it records nothing on 2.x.
  Follows-up: lane `01M6C85RT9`.
- 2026-11-01: lane `01M6C85RT9` fixed it. `readOpencodeRows` reads `session_message` first and the
  v1 tables when it is missing. The `/live` wake watcher shared the same v1-only read, so it is
  fixed too.
- A headless OpenCode wake is caught twice: here on idle, while the session is live, and at settle
  by ADR 783. The daemon's one-open-question rule makes the second a no-op.
- Follows-up: lane `01M67EA48P` (3d: interactive Codex).

## Observability & Evaluation

- **Traces:** the raised ask, `meta.question.inferred: true`, from a Grok, Muse or OpenCode seat.
  `team_report`'s question measures already count `inferred` (ADR 781).
- **Eval:** `lastMessage.test.ts` pins each reader on the measured shapes, including the
  turns that must read nothing: a tool call after the text, a new prompt, another finish, the v1
  fallback. `inferredQuestion.test.ts` pins the OpenCode store read and the busy withdrawal. It
  also pins Grok's raise and its withdrawal at the next tool call, no raise when the doorbell rang
  or the stop re-entered, and Muse's withdraw-then-judge at the next turn end.
- **Experiment:** over the next week, count inferred asks from Grok, Muse and OpenCode seats against
  their turn ends that finished on prose. **Falsify:** zero inferred asks from any one of the three
  while its seats worked interactively. For Muse that would mean the session id does not reach the
  hook; for the others, that the store shape in Context has moved.
