# Idle-wake canary — Claude Code

A directed steer to a Claude Code session idle at its prompt for nearly seven hours started a new turn 5.2 s after it was sent, and the woken model read the act by id ([ADR 558](../decisions/558-idle-at-prompt-wake.md), measured 2026-10-11, n=1).

## The run (2026-10-11; falsify: the audit rows and transcript lines below) <!-- claim: other -->

- **Setup.** Seat izzo, Claude Code 2.1.296, daemon and adapter on `2be1dc81` (feature epoch 32),
  `/mcp` reloaded after the daemon refresh. The session's last turn ended at 22:11:06Z. It sat
  untouched at its prompt until the canary, 6 h 46 m later.
- **Send.** nick ran `musterd send --act steer --to izzo 'canary: reply with the act id you read'`
  from their own terminal. Act `01M4Q7H1Y4F4XB355R0ESHE4V8`, stored at 04:56:53.444Z.
- **Timeline**, from the daemon audit (`~/.musterd/musterd.db`, table `audit`) and the session
  transcript:

| t (from send) | event | where |
| --- | --- | --- |
| 0 | act stored | `messages.ts` |
| +5.163 s | `interrupt.raised` for izzo, `detail.seam = 'idle'`, `act_kind: steer` | audit |
| +5.172 s | `idle_wake.injected {harness:'claude-code', ok:true, reason:null}` | audit |
| +5.215 s | `queue-operation enqueue` with the line verbatim | transcript |
| +5.288 s | the new turn's user entry | transcript |

  The 5 s is the coalescing window (`IDLE_COALESCE_MS`), as designed. Inject to turn took 116 ms.
- **The woken model** read the act by id (`team_inbox_check {ids:[…]}`) and answered with
  `accept` act `01M4Q7HFXVXPV3XZ05A77VV7FC` naming the id. That is a pass on every clause of the
  ADR 558 experiment.
- **Hearing.** `presence.hearing` rows for izzo read `hearing:'idle', reason:null` at each
  (re)connect that day (15:10, 15:43 and 18:28 local). The same day, ghost on opencode read
  `hearing:'deaf', reason:'no-inject:opencode'`, which is the deaf path working as designed.

## How Claude Code frames the pushed line (2026-10-11; falsify: the transcript entry for the turn) <!-- claim: other -->

The ADR and the line guards assumed the line would land as a plain user-role turn. It does land
with role `user`, but Claude Code wraps it and marks where it came from:

- The content is prefixed `Another Claude session sent a message:` and followed by a paragraph
  saying it came from another session, not the user. The paragraph tells the model to treat it as
  a teammate's request, never as the user's approval, and never as a reason to change permission
  settings, CLAUDE.md or config.
- The entry carries `isMeta: true`, `origin: {kind:'peer', from:'unknown'}`, `turnOrigin: 'peer'`
  and `promptSource: 'system'`.

So the model reads the line as a peer message with a no-escalation rider, not as something the
human typed. That is stricter than the ADR assumed, and it makes the daemon's id and field guards
and the adapter's `isPushableLine` a second layer, not the only one. The guards stay: the framing
belongs to Claude Code and could change in any release.

## Not measured yet

- **Hit rate.** One run, one pass. The ADR asks for 5.
- **A half-typed draft** at the prompt when the line lands: kept, lost or merged.
- **An open tool-approval dialog** when the line lands. The keyboard guard does not cover a dialog
  that is waiting on the human.
- **A held-message dialog** (`crossSessionInbound`). None reached the model. Whether Claude Code
  showed the human anything on screen was not recorded.

Follows-up: deferred — the four runs above are taken on the next idle-wake lane that touches the claude-code inject (2026-10-11)
