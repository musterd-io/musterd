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

## What the runs showed besides the numbers

- **A typed answer from the phone works.** nick did not pick an option on Q1. He typed "What do you mean which colour?" in the iOS app, and it arrived as `answer.text` with `answer_proof {channel: app, verified: true}` and woke the seat. (2026-11-03.)
- **A question with no context reads as nonsense to the person.** The test question's `why` named the check ("fifty's end-to-end check of seats-ask"), but the card gave nick no reason to care, so he asked what it meant. A real seat question needs a `why` a person can act on: what the seat is doing and what each option changes. (2026-11-03, nick.)
- **The seat mislabels channels in its own report.** ryder's closing message credited the phone with the `/live` answer. Read the channel from `answer_proof.channel`, never from the seat's prose. (2026-11-03.)
- **An agent's nudge to a capped seat waits, as designed.** fifty's follow-up steer to ryder at 22:47 was not leased: ryder had used three wakes that hour, and an agent's act is still rationed (ADR 790 decision 4). (2026-11-03.)

## Not yet measured

- A seat on shift (ADR 792): Start inside working hours, a claimed-work wake, and the `hours_end` stop at 15:00 Pacific with its board line. Follows-up: lane `01M6HSKWBZ76EJ714VHDHKF8XA`.
- A lock-screen answer with the question key (no app open), and answer → woke over more than two samples.

## How to re-run it

1. Ask the seat (by `request_help`) to raise two `team_question`s to a person, one after the other, each with a `why` that says what it is for.
2. The person answers one in the phone app and one on `/live`.
3. Read the times from the hub:
   `sqlite3 -readonly ~/.musterd/musterd.db "SELECT datetime(ts/1000,'unixepoch'), action, substr(detail,1,200) FROM audit WHERE target='<seat>' AND action LIKE 'residency.%' AND ts > <since> ORDER BY ts"`
   and the answer acts' `ts` from `messages` (`act = 'accept'`, `meta.in_reply_to` = the question id).
