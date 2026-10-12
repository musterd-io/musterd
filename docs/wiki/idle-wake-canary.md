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

## The opencode run (2026-10-12; falsify: the message rows and audit rows below) <!-- claim: other -->

Six steers to an opencode session idle at its prompt, five on valid 3–6 min windows: zero wakes.
The rail that failed is the idle push, not the probe — every steer surfaced through the mid-turn
`tool.execute.after` fence once the session was busy again.

- **Setup.** Seat ghost, opencode 1.19.0 (the handoff asked for 1.18.35 — version gap noted, not
  closed), plugin generation 5 (`musterd-interrupt v5`, `init --refresh-hooks` run 17:10 UTC),
  daemon and adapter on `e616efa0` (feature epoch 33). `presence.hearing` read `deaf`,
  `no-inject:opencode` through 10-11; after the refresh it reads `idle`, reason null, at each
  heartbeat (17:02, 17:39, 18:04 UTC). The idle hearing half is fixed; what follows is the
  delivery half failing.
- **Sends** (nick, `musterd send --act steer --to ghost`, `messages.ts` ts):

| trial | act | sent (UTC) | idle before (approx) | result |
| --- | --- | --- | --- | --- |
| 1 | `01M4RHPRJT5T9G8JC7A57D29DT` | 17:14:00 | ~4 min | MISS (+ confound, below) |
| 2 | `01M4RJ2Q8SZYWGYFH78VDW12XM` | 17:20:32 | ~1 min | MISS, short window — supplementary only |
| 3 | `01M4RJW499PE0QZT0P655TW08K` | 17:34:25 | ~5 min | MISS, daemon healthy |
| 4 | `01M4RKFX79ZFM88DRXPM2GSV41` | 17:45:13 | ~4 min | MISS, daemon healthy |
| 5 | `01M4RKXNTAE549CKV00F7Z3TY6` | 17:52:44 | ~3 min | MISS, daemon healthy |
| 6 | `01M4RMF1GK0QHQ9Y0CYY23X538` | 18:02:13 | ~5 min | MISS, daemon healthy |
| 7 | `01M4RN2928VMPT1GK6WX8B62PV` | 18:12:43 | ~2+ min | MISS — izzo's timed steer for the busy-hold test, landed while idle instead (my ask reached him ~6 min late, daemon stalling); no wake, no rows, no ring/ack |

- **The miss signature is identical all seven times** (falsify: `audit` for
  `interrupt.raised` / `idle_wake.injected` with `target='ghost'`, plus
  `.musterd/idle-ring*.json` in the seat workspace): no `interrupt.raised` row for the act
  while idle, no `idle_wake.injected` row ever, no `idle-ring.json` written, no
  `idle-ring-ack.json` — not even a `busy` or `line-shape` refusal, which would at least prove
  the plugin polled. The daemon never attempted the push as far as any observable shows. Each
  steer was raised only later, by the session's own mid-turn probe (`count:2` rows at 17:27,
  17:40, 17:47, 17:55), and each was read by id and answered in-turn.
- **Confound on trial 1:** guardian raised `daemon_down` at 17:14:39 (39 s after the send) and
  cleared it 17:16:43. Trials 3–6 ran against a healthy daemon, so the flap explains at most one
  of five qualifying misses.
- **What this localises.** Hearing heartbeats flowed all day, so adapter→daemon is alive.
  Mid-turn probes delivered every steer, so daemon→adapter→model works when the session is busy.
  What never fires is the idle leg — no ring file, no ack, no row (2026-10-12; falsify: `audit` rows for `target='ghost'` 17:10–18:15 UTC plus the absent `.musterd/idle-ring*.json`, both re-checked per trial above). <!-- claim: defect -->
  Suspects, unordered: the daemon
  never issues the ring for opencode seats; the ring is issued somewhere this workspace's plugin
  does not poll; or the push path silently drops. The ack file's absence cuts against
  plugin-side refusal — a refusal would have written `busy`/`line-shape`/`no-session`.

## Not measured yet (opencode)

- **Busy-hold.** A steer sent mid-turn should ring after the turn ends (15 s recheck, 10 min
  cap). STILL OPEN: the timed steer (izzo, 18:12:43) was meant mid-turn but landed idle-side —
  my request reached him ~6 min late through a stalling daemon, and he has offered another on
  cue. Daemon health is now visibly flapping (`musterd inbox` refused once 18:13 UTC, MCP read
  seconds later succeeded); the busy-hold attempt waits for stable ground.
- **TUI rendering.** No push ever arrived, so there was nothing to render. The mid-turn fenced
  lines render in-transcript; TUI display of a pushed prompt is unmeasured.
- **The 1.19.0 question.** All of the above is on 1.19.0, not the 1.18.35 the handoff named. A
  repeat on 1.18.35 would say whether the version matters; nothing in the miss signature points
  there (the plugin reports gen 5 and heartbeats carry `idle`).
