# Seats ask: the end-to-end check

How long a person's answer to a seat's question takes to reach the seat, measured live on the revive hub with ryder on `musterd-joiner-1`, and what the runs showed.

## The measured runs

Answer → woke is the answer act's `ts` to the `residency.woke` row for that act. Both are in the hub's store (`messages`, `audit`), so the run can be re-read.

**Round 1, 2026-11-03 05:17–05:25 UTC (before ADR 790).** One answer reached the seat.

| Answer | Channel | Answer → woke | Session |
| --- | --- | --- | --- |
| Q1 | `/live`, an option | 58 s | resumed |
| Q2 | `/live`, an option | never | — |

Q2's answer waited behind ryder's hourly wake cap (2 per hour): the cap was checked before the daemon read what was due, so a person's answer was rationed like an agent's act. That finding started [ADR 790](../decisions/790-human-acts-pass-the-wake-caps.md) and the seats-on-shift work. (2026-11-03; falsify: read round 2's Q2 row below.) <!-- claim: other -->

**Round 2, 2026-11-03 22:42–22:46 UTC (after ADR 790, 791, 792).** Both answers reached the seat.

| Answer | Channel | Answered | Leased | Woke | Answer → woke | Session |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | iOS app, free text | 22:43:33.9 | 22:43:35 | 22:43:51 | **17 s** | resumed |
| Q2 | `/live`, option "Square" | 22:45:09.1 | 22:45:11 | 22:45:40 | **31 s** | fresh |

- Median answer → woke: **24 s**, under the 30 s target. Two samples is a reading, not a distribution.
- Q2 was answered while ryder was inside its cooldown (`residency.wake_gate` `cooldown` at 22:43:23), and its lease row carries `human_pass: true`: the ADR 790 pass, working on the live hub. (2026-11-03; falsify: a `wake_leased` row for a human-sent act to a capped or cooling seat without `human_pass`, or no lease at all.) <!-- claim: other -->
- Q2's wake started a fresh session: the session digest changed between the two wakes (`cf53865c…` → `b44ab8a9…`), so the resume missed and the host fell back to fresh. It added time (the 31 s against 17 s) but nothing was lost: the fresh session got the answer's recap line. (2026-11-03; falsify: `residency.woke` for the Q2 act shows `session: resumed`.) <!-- claim: other -->
- Wake cost: $0.31 for the request wake, $0.07 for the Q1 answer (resumed), $0.22 for the Q2 answer (fresh).

**Shift run 1, 2026-11-04 19:08–20:11 UTC (ADR 792), partial.** nick pressed Start on ryder from the phone's Seats screen; /live has no Start for an offline seat (lane `01M6KZZ5WH`). He stopped it early at 20:11, because the daemon was stalling and the shift was suspected. It was not the cause (lane `01M6M61A0E`).

| Event | Time (UTC) | From the hub's `audit` |
| --- | --- | --- |
| Start | 19:08:55 | `shift.started` (`inside_hours: true`), `quick_action.sent` |
| Wake 1, for the Start itself | leased 19:09:12, woke 19:09:24 | **29 s** Start → woke; $0.50, 94 s |
| Wake 2, for ghost's act (batched lane) | woke 19:39:58 | $0.30, 80 s |
| Stop | 20:11:16 | `shift.stopped` `reason: stopped`, `spent_usd: 0.8`, `lanes_claimed: 2` |

- **No claimed-work wake fired in the hour.** In its first wake ryder asked nick a question (`01M6KZGVY8`, 19:10:39). That question stayed open until 20:22:15, which covered the rest of the shift. ADR 792 holds a shift's claimed-work wakes while the seat waits on its own question (`onShiftNow` → `waitingSeats`). So the shift spent its hour waiting on a person, as designed but invisibly: the roster said "on shift" and nothing said "waiting on nick". (2026-11-04; falsify: a `residency.wake_leased` row for ryder between 19:42 and 20:11 whose act is not a person's or a ghost act.) <!-- claim: other -->
- Start → first wake is 29 s, inside the 30 s target, though the daemon was mid auto-refresh at the time (down 19:09–19:11 UTC).
- Cost: $0.80 for the hour, in two wakes.

**Shift run 2, 2026-11-04 21:10–21:57 UTC (ADR 792), ended on its own.** nick answered ryder's questions from the phone as they came. All times are from the hub's `audit`.

| Event | Time (UTC) | Detail |
| --- | --- | --- |
| Start | 21:10:51 | `shift.started` (`inside_hours: true`), from nick's CLI |
| Wake for the Start | leased 21:11:00, woke 21:11:17 | **26 s** Start → woke; $0.55, 117 s |
| Wake for nick's answer (app) | answered 21:12:53, woke 21:14:03 | 70 s: ryder was still in the Start wake until 21:13:04; $0.24 |
| **Claimed-work wake** | woke 21:15:29 | `derivation: work_order`, `edge: dispatch_continuation`, lane `01M5GD23HK`; $0.36. ryder closed both its claimed lanes in this wake |
| Out of work | 21:26:04 | `shift.recommended`: a question to nick naming three open lanes to pick up |
| Wake for nick's answer (app) | answered 21:26:28, woke 21:26:55 | **27 s**; $0.32 |
| Wake for nick's answer (app) | answered 21:57:03, woke 21:57:30 | **27 s**; $0.33 |
| Stop | 21:57:47 | `shift.stopped` `reason: no_work`, `lanes_claimed: 0`, day `spent_usd: 2.72` |

- **The claimed-work wake fires.** With no question of its own open, ryder was woken for its claimed lane (`work_order`) two minutes after the Start wake ended, and closed the work. Run 1 never reached this. (2026-11-04; falsify: no `residency.wake_leased` with `derivation: work_order` for ryder between 21:13 and 21:16 UTC.) <!-- claim: other -->
- **Out of work, the shift asks, then stops.** With nothing claimed, the daemon asked nick which lane ryder should take (`shift.recommended`). After his answers it stopped the shift with `no_work`, an hour before working hours end. (2026-11-04; falsify: the `shift.stopped` row above reads another reason.) <!-- claim: other -->
- **Answer → woke from the phone: 26–27 s** for the two answers that found ryder idle, the same as /live. The 70 s one waited for the wake already running.
- Cost: $1.80 for 47 minutes over five wakes. The day's shift spend was $2.72 against the $10 budget.

**Shift run 3, 2026-11-06 19:45–23:00 UTC (ADR 792), ended at hours end.** nick pressed Start on ryder from the phone twice: the first shift ran out of work, the second ran to 15:00 Pacific. All times are from the hub's `audit` and `shifts` rows.

| Event | Time (UTC) | Detail |
| --- | --- | --- |
| Start 1 | 19:45:39 | `shift.started` (`inside_hours: true`), nothing claimed |
| Wake for the Start | woke 19:45:57 | **18 s** Start → woke; $0.73, 60 s |
| Out of work | 20:01:01 | `shift.recommended`, three lanes; nick picked the first (01M3AMY549, needs a person with a ChatGPT Business account) |
| Answers 1–3 (app) | woke 20:01:39, 20:04:17, 20:05:10 | **13 s, 16 s, 15 s** answer → woke; ryder released 01M3AMY549 and asked which lane nick meant |
| Stop 1 | 20:17:45 | `shift.stopped` `reason: no_work`, `lanes_claimed: 0`, day `spent_usd: 1.75` |
| nick's steer (CLI) | woke 20:23:51 | ryder claimed 01M6S2NYC4 (outcome quality, $0) |
| Start 2 | 20:33:20 | `shift.started`, one lane claimed |
| Wake for the Start | woke 20:33:36 | **16 s**; $0.58, 97 s; opened PR #4031, then asked nick a permissions question |
| Answers 4–6 (app) | woke 20:45:50, 21:05:17, 21:05:47 | 19 s, 20 s, 11 s; each wake ended in another permissions question |
| **Claimed-work wake** | woke 21:06:47 | `derivation: work_order`, `edge: dispatch_continuation`, from `board`; pushed the fix that turned #4031 green |
| (silence) | 21:07–22:33 | no wake, no gate row, shift row `state: on` — see below |
| fifty's steer | woke 22:34:05 | agent act, hourly cap clear; ryder updated the lane |
| Claimed-work wakes | 22:41:34, 22:42:34, 22:43:04, 22:44:04 | 55 s, 23 s, 23 s, 18 s; $0.42, $0.26, $0.45, $0.23 |
| **Stop 2** | 23:00:44 | `shift.stopped` `reason: hours_end`, `lanes_claimed: 1`, day `spent_usd: 5.93`; board line "ryder is off shift: hours ended at 15:00; 1 lane still claimed." |

- **The `hours_end` stop fires on time, with its board line.** 44 s after 15:00 Pacific, with a lane still claimed. (2026-11-06; falsify: the `shifts` row for ryder on 2026-11-06 reading another `stop_reason`.) <!-- claim: other -->
- **Start → woke 16–18 s and answer → woke 11–20 s** over two Starts and six answers, all faster than runs 1 and 2. The daemon was auto-refreshed several times during the run.
- **A shift goes silent when the seat works in git but leaves its lane record alone.** The 21:06 wake pushed commits but did not touch lane 01M6S2NYC4, so ADR 306's lane-moved guard (`laneMovedSinceLastWoke`) held every shift candidate for 88 minutes while the shift row said `on` and $10 of budget sat unspent. Telling the seat to update its lane each wake fixed the silence and caused a touch-to-re-wake loop instead: four wakes in three minutes. (2026-11-06; falsify: a `residency.wake_leased` for ryder between 21:07 and 22:33 UTC.) Follows-up: lane `01M6SHH0KXW2QK7GYPPNMWMGH5`. <!-- claim: defect -->
- **A wake that ends during a daemon restart loses its end report.** Five of the run's wakes have `residency.woke` but no `session_ended` or `wake_cost` row; the host logged "wake-turn post failed … can't reach the daemon" for the 21:06 one ($0.84, 132 s) and did not retry. The lease still reached `reported`, so it did not block the next wake. (2026-11-06; falsify: `wake_cost` rows for the 20:05, 20:23, 21:05:47, 21:06 and 22:34 wakes.) Follows-up: lane `01M6SHH4VPRRSP3NE88MDA6KEZ`. <!-- claim: defect -->
- **Waiting on its own question holds the shift, and nothing says so.** Three of ryder's questions to nick held the shift for 10, 18 and 1 minutes; the roster said "on shift" throughout. Same as run 1.
- **A headless wake cannot widen its own permissions.** ryder asked twice for allowlist entries; nick approved in the app, and Claude Code's own permission check still refused the edit to `.claude/settings.local.json` in a wake with nobody at the prompt. ryder refused to work around it. fifty added the three entries on the hub with nick's yes.
- **/live and the app cannot send a seat a typed message.** To redirect ryder, nick used `musterd send --act steer` from his laptop workspace. (2026-11-06; falsify: a send or steer control on the seat card in `/live` or the app at that date.) Follows-up: lane `01M6SHHGKWPND0YQ45Q1ATB8QA`. <!-- claim: defect -->
- **Not recorded:** the roster chip and `team_next` line while on shift.

## What the runs showed besides the numbers

- **A typed answer from the phone works.** nick did not pick an option on Q1. He typed "What do you mean which colour?" in the iOS app, and it arrived as `answer.text` with `answer_proof {channel: app, verified: true}` and woke the seat. (2026-11-03.)
- **A question with no context reads as nonsense to the person.** The test question's `why` named the check ("fifty's end-to-end check of seats-ask"), but the card gave nick no reason to care, so he asked what it meant. A real seat question needs a `why` a person can act on: what the seat is doing and what each option changes. (2026-11-03, nick.)
- **The seat mislabels channels in its own report.** ryder's closing message credited the phone with the `/live` answer. Read the channel from `answer_proof.channel`, never from the seat's prose. (2026-11-03.)
- **An agent's nudge to a capped seat waits, as designed.** fifty's follow-up steer to ryder at 22:47 was not leased: ryder had used three wakes that hour, and an agent's act is still rationed (ADR 790 decision 4). (2026-11-03.)

## Not yet measured

- A `budget` stop. Shift runs 1–3 measured Start → wake, a claimed-work wake, a person's stop, the `no_work` stop and the `hours_end` stop (run 3). Follows-up: lane `01M6SHHAXJQ8SGNK0G1R8ZBFHM`.
- A lock-screen answer with the question key (no app open). Answer → woke now has eight samples (runs 2 and 3), all from the app or `/live` with the app open.

## How to re-run it

1. Ask the seat (by `request_help`) to raise two `team_question`s to a person, one after the other, each with a `why` that says what it is for.
2. The person answers one in the phone app and one on `/live`.
3. Read the times from the hub:
   `sqlite3 -readonly ~/.musterd/musterd.db "SELECT datetime(ts/1000,'unixepoch'), action, substr(detail,1,200) FROM audit WHERE target='<seat>' AND action LIKE 'residency.%' AND ts > <since> ORDER BY ts"`
   and the answer acts' `ts` from `messages` (`act = 'accept'`, `meta.in_reply_to` = the question id).
