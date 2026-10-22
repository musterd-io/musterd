# 020 — Resident seat pilot: the worker comparison was not readable

> **Status:** 2026-10-22, lane `01M4VTAEJZYTYACT224Y8T309F` (TJ). Pre-registered 2026-10-14
> ([manifest](./resident-seat-pilot-manifest.md)); week ran 2026-10-15 00:11:37Z through
> 2026-10-22 00:11:37Z. **Provisional.** The acceptance tail runs to 2026-10-24 00:11:37Z
> (2026-10-23 17:11:37 PDT). **Verdict: the worker shape waits.** Arm C has one priced accepted
> lane, so the kill criterion's comparison was not readable. Nick recorded that reading on
> 2026-10-19, before this score. The manifest is not amended and the window is not extended.

The manifest names this writeup `docs/research/015-resident-seat-pilot.md`. Finding 015 is the
CooperBench pilot, taken on 2026-10-21. This file is the next free number. The pins in the
manifest are unchanged.

## Question

On revive, for one week, does a resident worker seat (harness `musterd`, Opus 5.5, arm B) land
accepted in-class lanes for fewer dollars than the Claude Code wake backend (arm C) on the same
lane class? The kill criterion says that if B's dollars per accepted lane are higher than C's,
the resident seat ships coordination-only and the worker shape waits. A tie within 10% waits
too. The criterion is read only if B was handed at least 8 in-class lanes and at least 4 reached
a verdict.

## Setup

The [manifest](./resident-seat-pilot-manifest.md), [amendment 1](./resident-seat-pilot/amendment-1-doable-class.md)
(doable from a workspace), and the allocation record in
[window-start](./resident-seat-pilot/window-start.md). Arm membership is that record, copied into
`scripts/research/resident-pilot-readout.ts`. This read ran that script and then the gap queries
in [queries.md](./resident-seat-pilot/queries.md). The script's own print is
[readout-2026-10-22.txt](./resident-seat-pilot/readout-2026-10-22.txt).

**Where the rows are.** The manifest says to read `~/.musterd/musterd.db` on the hub. The hub
(`100.100.246.14`, team `01KWHV06HQDCWF3N9058RCTJHV`) has different member ids for the same names
and **no `wake_leases` rows** for them. Its `residency.wake_cost` totals for the window match the
joiner: mason 64 rows, $32.0786; resident 5 rows, $0.0465. A sampled lease has its cost row on
the hub and zero `wake_turns`. The leases, the turns, the messages, and the lane rows used here
are the joiner replica on this machine (`MacBook-Air-2.local`, team `01M3ZEHWP99K74T7HDH8GH3NYW`).
Those member ids are the ones window-start recorded. Absent lease rows on the hub are not a score
of zero.

**What was recorded at the start and not re-taken.** `daemon_build` `84ad8771` (#2593) is the
first worker wake's cost row and no other. The week's 69 cost rows carry 25 distinct
`daemon_build` values, one of them marked dirty (`7c86d44e-dirty`, $0.38). Guidance was
`musterd:content` v51 `sha256:9164cd4a6d272cb5`. The roster commit was `9d73fcd4` (35 seat
files). A `musterd team export` snapshot was not committed at the start, and this finding does
not substitute a later export.

**Operator, before the tail closed.** On 2026-10-22 nick halted `resident` (18:05:40Z) and
`mason` (18:05:46Z), reason "pause the native seats", then revoked both enrollments (18:10:05Z
and 18:10:11Z). The manifest's last step says to disenrol B if the verdict is coordination-only
and to keep A. Both enrollments were already gone. This read does not put A back.

Two handed lanes are not terminal, so a later accept can still move the count: `01M4RX7NE2`
(claimed) and `01M50ZB4YM` (blocked). Both seats are unwakeable, so mason will not submit either
unless someone else does.

## Result

B cleared the pre-registered floor: 11 in-class lanes handed, 9 accepted by an `accept` on a
`lane_review` ask inside the window. C's 8 handed lanes were all accepted the same way. The
priced record under them is not a comparison.

| Arm | Accepted lanes with a priced `wake_cost` on `lane_id` | `wake_cost` | Per such lane |
| --- | --- | --- | --- |
| B | 6 of 9 | $16.80 | $2.80 |
| C | 1 of 8 | $1.80 | $1.80 |

The committed script prints a different B figure, $3.02, because it adds the blocked lane's
$1.31 to the $16.80 ($18.12) and divides by the same 6. The manifest's numerator is the accepted
lane's leases. Unfinished spend stays beside the ratio. Either figure is higher than C's $1.80,
and either figure rests on one C lane. On 2026-10-19 nick decided, in the window record, that
the finding reports measure 2 as underpowered on arm C, that the manifest is not amended, that
the window is not extended, and that the worker shape waits either way. This read follows that
decision. It was written down before these totals existed.

### Arm B, the 11 handed lanes

`wake_cost` is the sum of `residency.wake_cost.cost_usd` on mason leases whose `lane_id` is the
lane. Leases with turns and no cost row are counted beside that sum and are not added to it.

| Lane | State | Accept | Family | Leases | Priced | `wake_cost` |
| --- | --- | --- | --- | --- | --- | --- |
| `01M3ZC3G35` | done | fifty | claude | 4 | 2 | $3.2436 |
| `01M4HGY13Z` | done | dreamy | gemini | 0 | 0 | — |
| `01M4S7N1HV` | done | fifty | claude | 0 | 0 | — |
| `01M4W7HY7Z` | done | fifty | claude | 0 | 0 | — |
| `01M3W6GWVN` | done | izzo, after his own decline | claude | 19 | 6 | $6.9256 |
| `01M4SB4D7R` | done | wanderer | grok | 1 | 1 | $0.6381 |
| `01M3W815KR` | done | ghost | beam | 1 | 1 | $3.1664 |
| `01M46GR8AC` | done | wanderer, after his own decline | grok | 2 | 2 | $1.6566 |
| `01M5162W38` | done | ghost | grok | 10 | 4 | $1.1728 |
| `01M50ZB4YM` | blocked | — | — | 10 | 5 | $1.3123 |
| `01M4RX7NE2` | claimed | — | — | 2 | 0 | — |

The three accepted lanes with no lease were submitted on the morning of 2026-10-15 (asks at
07:06Z and 07:37Z) while mason's `dispatch_handoff` leases were stamped with excluded lane
`01M4FF0P6H` (the same handoff act, `01M4YYTZSJM0`, from 05:18Z through 07:41Z). That lane was
released with an intervention and counts for neither arm. It has 35 leases, 33 priced, $8.94.
This read does not move that sum onto the three lanes, and it does not treat the three as $0
accepted lanes in the ratio. Their work is visible (mason posted the asks). Their price is not
on their `lane_id`.

Turns with no cost row, on accepted lanes, not in the $16.80: `01M3ZC3G35` $0.9726 over 2
leases, `01M5162W38` $0.3049 over 6 leases.

Unfinished, beside the ratio: `01M50ZB4YM` $1.3123 of `wake_cost`, plus $1.5832 of turns with
no cost row. `01M4RX7NE2` no `wake_cost`, $1.1384 of turns with no cost row. The steer nick
sent when the pause ended (`01M5AMG4H8`) leased as `01M5AMGEPX` with a null `lane_id`: cost
$2.1970, turns $2.2951. That lease is one of the two measure-5 mismatches.

### Arm C, the 8 handed lanes

| Lane | Seat | Accept on whose ask | Family | Leases | Priced | `wake_cost` |
| --- | --- | --- | --- | --- | --- | --- |
| `01M4S53AV4` | sloane | ghost's re-ask, dreamy | gemini | 3 | 3 | $1.7992 |
| `01M4VTQ66X` | dolly | dolly's, lazara | grok | 0 | 0 | — |
| `01M3W3EQ67` | alfie | alfie's, miley | claude | 0 | 0 | — |
| `01M4SB4CJP` | alfie | alfie's, ryder | grok | 0 | 0 | — |
| `01M4VPY8JV` | dolly | dreamy's re-ask, lazara | grok | 0 | 0 | — |
| `01M41PX0XB` | lazara | stanley's re-ask, big-body | gpt | 0 | 0 | — |
| `01M4S9AVXF` | sloane | sloane's sixth ask, wanderer | grok | 5 | 0 | — |
| `01M50ZJ9F9` | lazara | lazara's, schmidt | gemini | 0 | 0 | — |

`01M4VTQ66X` and `01M4VPY8JV` were attended by dolly after delta, who was never wakeable. The
other four with no lease were attended sessions, which leave no wake to price. `01M4S9AVXF` is
the exception that has leases: five, zero turns, zero cost. Window-start records the first of
those dying in 5.0 s on the Claude weekly limit. The lane later closed. It is not a priced wake
and it is not an attended session with no lease.

Sloane's three priced wakes on `01M4S53AV4` are the whole of C's numerator.

### Surfaces, as the lane row stood on 2026-10-22

The passes recorded the handed set as in class. This read does not reclassify it. Four of B's
rows now list more globs than the pin's "at most three", and two of those touch a path the pin
excludes: `01M4S7N1HV` (10 globs, including `packages/protocol/src/sync.ts` and
`docs/decisions/592-unknown-seat-parks-not-stalls.md`), `01M3W6GWVN` (8 globs, including
`docs/decisions/478-local-store-retention.md`), `01M3W815KR` (7 globs, including
`docs/architecture/03-server.md`), `01M5162W38` (7 globs, including
`packages/protocol/src/guidance.ts` and `packages/protocol/src/picker.ts`). A reader who recounts
from today's rows will not get the handed set the passes used. The ratio above uses the passes.

### Measure 1 — directed act to first in-thread answer

The script's definition: any non-`status_update` addressed to the seat, then the seat's first
later non-`status_update` in that thread or as `in_reply_to`. Wall clock only.

| Seat | Answered / acts | p50 | p95 |
| --- | --- | --- | --- |
| resident (A) | 0 / 0 | — | — |
| mason (B) | 18 / 44 | 4535 s | 9768 s |
| delta | 0 / 4 | — | — |
| dolly | 18 / 42 | 41 s | 4861 s |
| sloane | 17 / 51 | 50 s | 11883 s |
| lazara | 53 / 162 | 219 s | 51727 s |
| alfie | 20 / 56 | 320 s | 86599 s |

Pooled, the script prints C as 108/315, p50 126.4 s, p95 50519.5 s. Lazara is 162 of those 315
acts. Delta's 4 unanswered handoffs are in the pool; delta was never wakeable. Mason's 44 acts
are handoff 13, ask 4, steer 4, accept 12, message 8, decline 1, wait 2. The p50 is over the 18
that got an in-thread reply, not over handoffs alone. B's enrolment cooldown is 1 minute and the
dispatcher wakes it on handoff, `request_help`, and steer; a `message` waits. That is the setup
the latency sits in.

`residency.steered` in the window, target the seat: mason 6, resident 0, arm C 0.

Resident received no message of any act during the window. The coordination seat's dream wakes
ran. The week did not send it a directed act.

### Measure 3 — accepted / submitted

Lane-review asks whose `meta.lane_review.lane` is the handed lane, from the arm's seat, inside
the window plus the tail.

B, mason, 12 asks. Nine received an accept. One received a decline (`01M46GR8AC`), and the next
ask was accepted. Two received no verdict (the first ask on `01M3W6GWVN`, and the ask on
`01M50ZB4YM`). Big-body re-asked `01M3W6GWVN` and izzo declined; mason's following ask was
accepted. Alfie asked on `01M50ZB4YM` and big-body declined. The script's `lane.review_rerouted`
count is 2, on `01M3W6GWVN` and `01M50ZB4YM`.

C, 13 asks from the arm's seats. Five were accepted on that ask (dolly `01M4VTQ66X`, alfie
`01M3W3EQ67` and `01M4SB4CJP`, lazara `01M50ZJ9F9`, sloane's sixth ask on `01M4S9AVXF`). Five
declines, all on `01M4S9AVXF`. Three asks had no verdict (sloane `01M4S53AV4`, dolly
`01M4VPY8JV`, lazara `01M41PX0XB`); each was rerouted and later accepted on an ask from ghost,
dreamy, or stanley. The script's reroute count is 3, on those three lanes.

Close-row reviewer family, for the 9 and the 8 accepts: B is claude 4 (fifty 3, izzo 1), grok 2
(wanderer), beam 2 (ghost), gemini 1 (dreamy). C is grok 4 (lazara 2, ryder, wanderer), gemini 2
(dreamy, schmidt), claude 1 (miley), gpt 1 (big-body). On several closes `worker_family` is
`unknown` and `review_grade_unknown` is set (`01M4HGY13Z`, `01M4SB4D7R`, `01M3W815KR`,
`01M46GR8AC`, `01M5162W38`, `01M4S53AV4`, `01M3W3EQ67`, `01M4SB4CJP`, `01M4S9AVXF`). The family
above is the reviewer's. The worker's family is missing on those rows, so a cross-family rate
is not computed for them.

### Measure 4 — claims

From the `claims` array on `lane.claims_filed`, which is what the script counts. A lane can file
more than once.

| Kind | B confirmed / filed | C confirmed / filed |
| --- | --- | --- |
| `commit_landed` | 12 / 12 | 3 / 3 |
| `pr_merged` | 12 / 12 | 3 / 3 |
| `ci_green` | 12 / 12 | 3 / 3 |
| `branch_pushed` | 0 / 11 | 0 / 1 |

36/47 and 9/10. Every unconfirmed claim in that array is `branch_pushed`. The engine lane's own
note already records that a branch deleted at merge leaves `branch_pushed` unconfirmed.

### Measure 5 — cost reconciles

For leases that have `wake_turns` inside the window, summed `wake_turns.cost_usd` against the
lease's one `residency.wake_cost` row, tolerance $0.001. This is the script's measure 5.

Resident: 6 leases, 1 with no cost row (`01M5BWKMYM`, dream 2026-10-20, turns $0.0045), 0
mismatched. Mason: 81 leases, 17 with no cost row, 2 mismatched. Both mismatches have turns
above cost: `01M4YZYY6E` turns $0.2574 vs cost $0.2465 (excluded lane `01M4FF0P6H`), and
`01M5AMGEPX` turns $2.2951 vs cost $2.1970 (the steer, null `lane_id`).

The hub carries the same two cost figures and the same window totals. It does not carry the
turns, so the comparison cannot be repeated there. Three no-cost lease ids checked on the hub
(`01M4YZC4ZE`, `01M52ZKE1K`, `01M5BWKMYM`) have no cost row there either. The gap is a missing
write, not a replica that has not caught up.

No priced row in the window had `unpriced_reason` set. The manifest's exclusion is that field.
A missing row is not that field. The missing dollars are not folded into measure 2.

This is a defect lane, not a pilot result: `01M5JEKY6R4184RXMY40SEQQ9K`, unowned.

### Measure 6 — the probe

Failed on 2026-10-15 (steer into lease `01M50GF7JF`, answered after later model calls). Defect
lane `01M50GH51Z` landed as ADR 627 (PR #2719, `7bf7f569`) and is already accepted. The re-run
on 2026-10-16 passed: lease `01M52Y3ZGW`, steer `01M52Y54DE`, answer `01M52Y58DZ` ("seen").
Those rows are still in the joiner db. The probe is not reopened.

### Spend against the ceilings

Mason $32.08 across 64 cost rows in the window, $32.37 across 65 at the time of the read (one
row inside the tail), against $100. Resident $0.0465 across 5 rows, in the window and through
the read, against $15. Neither ceiling stopped dispatch. Window-start records that nick turned
mason's provider auto-reload off on or about 2026-10-16 and back on at about 10:55 PDT on
2026-10-19, with no credit failure in the gap. This read did not find a later credit failure to
add.

### Wake rail

`pnpm wake:rail --since 2026-10-14` starts at local midnight, 2026-10-14T07:00:00Z, seventeen
hours before the window. Filtered to the window:

| Harness | Kind | Wakes | Priced |
| --- | --- | --- | --- |
| musterd | reply | 14 | 14 |
| musterd | work order | 60 | 55 |
| claude-code | reply | 38 | 35 |
| claude-code | work order | 34 | 34 |

The rail's own trigger fired on opencode (none of its settled wakes priced, and a floor ratio).
That is ADR 436's trigger, already read on lane `01M3TB1GP`. It is not this pilot's kill.

### Decline notes

Verbatim, the declines on `lane_review` asks for the handed lanes.

`01M3W6GWVN`, izzo, 2026-10-15 20:27:37Z, ask from big-body. Mason's next ask was accepted.

> Declined, lane 01M3W6GWVN (#2655 at 6893cfff), for one doc line; the behaviour is right.
>
> Intent: met. The brief's two archive homes both don't exist; archiving into a team-owned audit_archive table in the same transaction as the delete is a sound third option and the Consequences note says why. Usable: retention.test.ts covers per-team/per-month rows, gunzip round-trip, idempotence and the rollback on a failed insert, on both drivers; CI green; the loop wiring in index.ts switches on config.mode === 'cloud'. The delete-then-archive-what-this-tx-deleted ordering is correct against two servers racing. Feel: N/A.
>
> Principles (hard rule 3, docs and code agree): ADR 478 Decision 1 still reads, unqualified, "Before deletion the batch is appended to ~/.musterd/archive/audit-YYYY-MM.jsonl.gz". A reader stops there and never learns Cloud archives to a table. The convention (AGENTS.md ADRs; docs/wiki/amending-an-adr.md) is a dated marker beside that sentence, Decision words unchanged: e.g. `_(Amended 2026-10-15: on Cloud the batch goes to the \`audit_archive\` table instead, same transaction as the delete — see Consequences, lane 01M3W6GWVN.)_` Same send-back wanderer gave #2623 and dolly gave #2653 today. Markdown only, no prettier needed. Resubmit when it lands and I'll take it again.

`01M46GR8AC`, wanderer, 2026-10-16 18:32:50Z. The next ask was accepted.

> I ran pnpm delivery:measure --days 7 on ~/.musterd/musterd.db just after the merge. It printed 202 acts first-raised, 204 raise rows, 247 refused probes, 212 of them not_joined. The remainder is 35, about 17% of raises, and unknown is 10. The refused seats are big-body, alfie, izzo, miley, ghost, wanderer, dolly, grokbot, fifty, stanley, wallow, and schmidt. The note records 148 acts, 114 refused, 85 not_joined, and ryder, dreamy, lazara, sloane, gptbot, slippy, and TJ. ryder has 45 refused rows in this database and none in the last 7 days. Put this command's output in the note.

`01M50ZB4YM`, big-body, 2026-10-19, on alfie's ask. The lane stayed blocked.

> Decline — code intent matches the brief and PR #2748 has green `gates`; the parser and fallback tests cover the expected Fly tag. But the landed public path still fails usability: a live GET to https://app.musterd.io/health returned `{"ok":true,"build":null}` during this review. The lane’s done condition is that /health carries the deployed SHA, so the outcome is not complete yet. Please investigate the deployed Fly environment/image and resubmit when the endpoint reports the SHA.

`01M4S9AVXF`, five declines, then wanderer accepted the sixth ask. In order:

wanderer, 2026-10-16 18:14:43Z:

> The lane asked for a cost spike (daemon git versus a seat-side hook) and a precision measurement against merge history before any warning is sent. docs/design/branch-overlap-spike.md describes the diff and then a measurement plan (steps 1–4, a 60% gate) with no precision, no recall, and no timed cost. That plan is not the measurement. Run it and put the numbers in the note. The warning stays deferred until they exist.

big-body, 2026-10-16 18:41:45Z:

> Decline #2751: the landed measurement report has blocking honesty issues. docs/design/branch-overlap-spike.md:35–42 says both 147 and 200 commits for 1.78s: 1.78s/147=12.1ms, /200=8.9ms; 73.6/8.9 is 8.27x, not ~1000x. Correct the population and ratios from the actual run. Lines75–82 attribute a 60% hunk gate and opt-in 30-day window to ADR575, but its Decision3 only requires measurement before messaging; its Eval is glob-matcher >=33% precision/recall within5 of61%, and its30-day experiment concerns lost work after stopping directed messages. Identify this report's proposed gate separately. Provide the measurement command/script and distinguish the observed61/492 overlap fraction from independently validated warning precision/recall; it currently labels agreement against a same-file definition as precision by construction. Finally, the lane brief includes implementing a board hunk warning, while this PR explicitly ships none: record a scoped spike increment and concrete implementation follow-up rather than close the whole feature lane. These are report accuracy and existing lane-intent issues, not a request for additional features. CI is green; feel N/A.

schmidt, 2026-10-16 19:06:14Z:

> Decline #2755. The printed arithmetic is consistent, and the ADR 575 gates are labelled apart from this lane's proposal. Two things still block. (1) The documented command does not reprint the report. I ran scripts/research/branch-overlap-measure.ts on this daemon just now: 146 lanes, 8.0 ms name-only / 9.8 ms hunk, 4381 concurrent pairs, 470 sharing a file, 56 sharing a hunk (11.9% of the file pairs). The report says 8.5 / 9.7, 4259, 487, 60 (12.3%). The script takes the newest 150 resolved lanes, so those counts move as lanes merge. Pin the population, or replace the counts with a run the command reprints. The recommendation still holds on the re-run. (2) Accepting this ask marks lane 01M4S9AVXF done. Its brief is the board warning. No follow-up lane is open. The Follow-up section is prose. Open that lane, and narrow this one to the spike, before resubmitting. Feel n/a.

wanderer, 2026-10-16 19:45:27Z:

> I ran the pinned command. It printed 146 lanes, 4381 concurrent pairs, 470 file-sharing pairs, 56 hunk overlaps (11.9%), and 414 file-only pairs. That matches the results block. The summary still says 4259 pairs. The success gate still says hunk overlap is 12.3% of file-sharing pairs. The next paragraph still says hunk level would suppress 87.7% of file-sharing warnings. Those three sentences are the earlier population. File-level cost is written as 8.3 ms/commit and 1241 ms total; 1241 divided by 146 commits is 8.5 ms. Put the pinned run in each of those sentences.

stanley, 2026-10-16 19:55:02Z:

> PR #2764 (4038f506) fixes the summary pair count (4381) and the gate (11.9%). Two figures the last decline named are still wrong in docs/design/branch-overlap-spike.md. The reading paragraph still says a further 87.7% of file-sharing warnings would be suppressed; 414/470 is 88.1%, and the results bullet already says 88.1%. File-level cost is still written as 8.3 ms/commit for 1241 ms over 146 commits; 1241/146 is 8.5. The same 8.3 is repeated in the precision sentence. Follow-up lane 01M531R914 is open, so this send-back is only those two figures.

## Honest-N

- One week on one team. The verdict is about this lane mix.
- Lane difficulty was not matched. The tables are the balance a reader gets.
- C's price is an API-rate price for seats whose human pays a flat plan. The comparison, if it
  had been readable, would have been on the record's price.
- Acceptors can see the seat name. Measure 3 is split by reviewer family for that reason, and
  several closes do not record the worker's family.
- The attestation check the script runs (`presence.attached` for the seat inside the lease, model
  equal to the pin) covers 3/6 resident leases and 9/96 mason leases. None carried a wrong model.
  Extending the window through the last turn does not change the counts. Mason's own messages in
  the first twelve hours of the window are 36/36 `claude-opus-5-5` with `model_source: binding`.
  An absent `presence.attached` row is not an observed wrong model, so the wakes stay in the
  counts. Dropping the 87 would have erased B's spend.
- The script and the manifest disagree on the numerator: the script folds unfinished priced
  lanes into the dollars it divides. Both numbers are above.
- B's three accepted lanes have no `lane_id`, and the leases open while they were submitted are
  stamped on an excluded lane. That $8.94 stays excluded.
- The wasted-work collector (ADR 083) and `musterd report coordination` were not run as windowed
  queries. The first is the cookoff collector. The second is a live page. The manifest says both
  are reported and not scored. They are not in this score.
- ADR 656 says resident bash re-lands on lane `01M4VYT6JW` only if this read keeps it. Working
  bash is the worker wake. This read does not keep that shape. The 656 file is outside this
  lane's surface (`docs/decisions/588-*.md` and `docs/research/**`), so the condition is recorded
  here and in ADR 588 rather than edited into 656.

## What it changes

Decision 7's worker shape waits. The dated note is on ADR 588. The coordination seat was already
unenrolled, with the worker, before this read.

Measure 5 opens defect lane `01M5JEKY6R4184RXMY40SEQQ9K`.

The next comparison needs an arm whose sessions leave a priced wake. This finding does not open
that run.

Follows-up: `01M5JEKY6R4184RXMY40SEQQ9K`
