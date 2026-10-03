# Typed-act adoption — what the ledger says about prose vs typed acts

Seats use the typed act vocabulary about as often as prose, and the real gap is not vocabulary but threading: almost every agent→member prose message starts a new thread, including the ones that answer an open directed act.

## The premise this page retires

ADR 167 (2026-08, `:261`) recorded "all-time hint-eligible volume is ~40 acts, against 136 free-text
`message` acts — the team talks in prose rather than the typed act vocabulary". That was true of the
first weeks. Measured again on the live ledger (`~/.musterd/musterd.db`, 90 days to 2026-10-03,
lane 01M3TB3C0D), it no longer describes the team.

## The numbers (90 days to 2026-10-03)

Sender kind `agent`, by act:

| act             | rows      |
| --------------- | --------- |
| `message`       | 9,163     |
| `status_update` | 6,457     |
| `accept`        | 1,208     |
| `ask`           | 1,111     |
| `resolve`       | 267       |
| `request_help`  | 262       |
| `wait`          | 227       |
| `handoff`       | 151       |
| `decline`       | 150       |
| `steer`         | 69        |
| `insight`       | 52        |
| `challenge`     | 16        |
| `defer`         | 6         |
| **typed total** | **9,976** |

Typed : prose is 1.09 : 1 across agents. Humans: 66 prose against 51 typed. `service` seats
(daemon loops) send `status_update` 571, `ask` 90, `message` 4 — the daemon speaks typed.

Where agent prose goes, and whether it joins a thread:

| audience    | root  | in-thread |
| ----------- | ----- | --------- |
| `member`    | 3,511 | 105       |
| `team`      | 5,465 | 79        |
| `broadcast` | 3     | 0         |

**97% of agent→member prose is a root message** (3,511 of 3,616). By sender provenance, `session`
sends 3,153 of the member-addressed prose, `wake` 154, and 309 carry no provenance (older rows).

The cost of a root where a thread was open: of the 3,511 root prose sends to a member, **908 went to
a member who had an unanswered directed act (`ask` / `request_help` / `handoff` / `challenge`) waiting
on the sender from the previous 7 days** — a prose answer that leaves the ask open and unjoinable,
which is the starvation ADR 167 diagnosed. 2,009 had _some_ directed act from that member in the
window, answered or not. (Query: a root `message` from an agent to a member, with an `x` from that
member to the sender in the prior 7 days and no row from the sender in `x`'s thread or carrying
`in_reply_to = x.id` between the two.)

Measured on the live ledger (2026-10-03; falsify: re-run the two queries under "How to re-measure" over a 90-day window — typed total still at or above prose, and root share of member-addressed prose still above 90%). <!-- claim: other -->

If the root share has fallen below 70% after the hint below shipped, the hint is working and this
page is stale: invalidate the 97% line with a dated strike.

## The one fix the data supports

A send of a root `message` to a member who has an open directed act waiting on the sender now gets
one advisory line in the ack, on both surfaces (`musterd send`, `team_send`), naming the act and the
thread to join next time (`threadHintFor` / `threadHintText` in `@musterd/protocol`, lane
01M3TB3C0D, 2026-10-03). Warn, never block: the send already happened. The candidate set is the same
open-answerable set an un-named verdict auto-targets, so the hint and the auto-target cannot
disagree about what is open.

Not done, deliberately: a vocabulary nudge ("use a typed act"). Typed already dominates; the ledger
does not support that story.

## How to re-measure

```sh
C=$(( ($(date +%s) - 90*86400) * 1000 ))
sqlite3 -readonly ~/.musterd/musterd.db "
select m.kind, msg.act, count(*) from messages msg left join members m on m.id=msg.from_member
 where msg.ts > $C group by 1,2 order by 1,3 desc;
select msg.to_kind, msg.thread_id is null as root, count(*) from messages msg join members m on m.id=msg.from_member
 where msg.ts > $C and m.kind='agent' and msg.act='message' group by 1,2;"
```

Run read-only against the daemon's database; the laptop hosts a dozen seats, so keep it to these two
statements rather than a scan per row.
