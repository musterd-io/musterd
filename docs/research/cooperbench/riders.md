# CooperBench riders: measures any future musterd run reports

**Lane:** `01M5KHD19K` (goal `cooperbench`). **Status:** pre-registered 2026-10-23. A rider is a measure
fixed in advance and read from whatever musterd run next produces the data. It never decides that
run's primary verdict and never changes what the agents are told or how pairs are scored. A rider
is added here before the run that reads it, and is not edited after.

## Rider 1: does the held-file refusal now lead agents to wait, not message? (#3219)

**What changed.** #3219 (2026-10-22) made the held-file refusal lead with the one-call wait on the
holder's lane, by id (`team_inbox_check {wait: 45, until_lane: "<id>"}`), with asking the holder as
the second option. The agents' instructions (#3177) already named that wait before and after, and
are unchanged.

**Measure.** For each held-file refusal an agent saw (`blocked: '<path>' is held by …`, not ADR
697's one-time hand-over), the agent's next musterd move, read from its own stream by `readout.py`'s
`held_refusal_moves`. Board reads (`lane_board`, `team_status`, `lane_show`) are skipped, because
they do not answer the refusal. The rider's number is the share of held refusals whose next move is
`wait_until_lane`.

**Baseline**, read with the same code from the claim run (2026-10-22, the old text, 20 pairs):

| Next move after a held refusal | Claim run |
| --- | --- |
| `team_inbox_check {wait, until_lane}` | **2** |
| `team_inbox_check {wait}` (no lane) | 4 |
| `team_inbox_check` (no wait) | 4 |
| a message to the holder (`team_send`) | 19 |
| **Held refusals** | **29** |

Pilot 3 is not a baseline. The blocking wait did not exist yet.

**Verdict rule**, one-sided Fisher's exact test of the new run's `wait_until_lane` count `k` out of
`H` held refusals against 2/29, read once, from the first musterd run on a build at or after #3219
that has `H ≥ 8`:

- **`k` at or above the threshold below:** "after #3219, refused agents waited on the holder's lane in
  one call in k of H refusals, against 2 of 29 before".

  | `H` | 8 | 10 | 12 | 15 | 20 | 25 | 30 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | `k` needed | 4 | 4 | 5 | 5 | 6 | 7 | 8 |

  For an `H` not in the table, the threshold is the smallest `k` with p < 0.05, computed the same way.
- **Below it:** "no change measured". The counts are reported, and #3219 stays in place: it
  reads better for a person too.
- **`H < 8`:** reported, no rule.

The share of held refusals followed first by a message to the holder (19/29 before) is reported
beside it, with no rule.

**Not gaming.** The rider adds no instruction, hint or tool to any arm. If a run reads it, the
finding says which run, which build and which arm.

## Rider 2: after a lane frees a held file, do holders stop announcing it? (ADR 724)

**Lane:** `01M5N3THX3`. **Status:** pre-registered 2026-10-23, before ADR 724 is built. First read 2026-10-24 in [finding 025](../025-cooperbench-coordination-cost-run.md) (`rider2.py` beside that run): the act was delivered in 9 of 10 `core` pairs; holder signals 18 against 23; freeing → next gated edit medians 30 s against 35 s.

**What changed.** [ADR 724](../../decisions/724-held-refusal-watches-the-holders-lane.md): a
held-file refusal opens a watch on the holder's lane. When the lane frees the file (done,
abandoned, released, or the file leaves its scope), the refused seat gets one directed act with
the holder's branch and head. The agents' instructions do not change.

**Measure.** In the musterd pairs with at least one held refusal, the holder's state-signal sends
per pair: `team_send` calls that finding 019's `is_signal` labels (`pilot-runs/2026-10-21-pilot3/cost/cf.py`,
unchanged), sent by the seat whose lane held the file. Beside it, the time from the holder's lane
freeing the file to the refused seat's next edit of it, read from the two streams and the daemon's
audit rows.

**Baseline.** The same two numbers, read with the same code from the claim run (2026-10-22, 20
pairs) before the new run is read, and recorded in that run's finding next to the new ones.

**Verdict rule.** None. Reported only: pairs with held refusals are few (5 of 9 in the rider run),
and per-pair signal counts are small, so no test would be fair at the size of a run we would pay
for. ADR 724's own falsifier reads these numbers: holder signals do not fall, or refused agents
still wait for the holder's reply rather than the act.

**Not gaming.** As rider 1: no instruction, hint or tool is added to any arm for it.

## Rider 3: did findings 022's product changes remove the calls they were for? (one-call orientation, ADR 726, ADR 724)

**Lane:** `01M5QDHJEE`. **Status:** pre-registered 2026-10-24, before the run that reads it
([coordination-cost manifest](./coordination-cost-manifest.md)). **Read once 2026-10-24** in
[finding 025](../025-cooperbench-coordination-cost-run.md): R3a 29 (did not act; 20 of the 27 and of
the 29 are the instructed first `team_inbox_check`, which the rule's baseline counted), R3b 6
(acted), R3c 41 calls, no kind fell.

**What changed.** One call orients a seat at session start (#3289): the first reply carries the held
lanes, the open count and directed acts, so no `team_status` / `lane_board` / inbox before a claim.
ADR 726 (#3271, #3280, #3283, #3285): `working` is read from lane activity, and no instruction tells
an agent to post a status update. ADR 724 (#3269, #3279): a held-file refusal watches the holder's
lane and a directed act wakes the refused seat when the file frees up. The agents' instructions
(#3177) are unchanged.

**Measure.** Three counts over the 10 `core` pairs, by the claim run's residue scripts unchanged
(`pilot-runs/2026-10-22-claim/residue/boardreads.py`, `sends.py`):

| | Count | Claim run (`core`) |
| --- | --- | --- |
| R3a | board reads with `context = before first claim` | 27 of 100 |
| R3b | `status_update` sends that `is_signal` does not mark | 40 calls, $0.94 |
| R3c | sends `is_signal` marks, by kind | 34 calls, $0.69 (pushed 10, merged 16, lane done 4, ETA 2, other 2) |

**Verdict rule**, read once from the first complete musterd run on a build at or after #3289 over all
10 `core` pairs: R3a **≤ 9** "the one-call orientation removed the orientation reads", **≥ 22** "it
did not"; R3b **≤ 13** "dropping the instruction removed the status updates", **≥ 32** "it did not";
between the two, "part of it", reported with the labelled rows. R3c is reported by kind with no
rule: the kinds ADR 724 carries are 4 and 16 calls, too few for a fair test at ten pairs, and
"pushed" has no product event yet. Each rule stands alone.

**Not gaming.** As riders 1 and 2: no instruction, hint or tool is added to any arm for it. The
orientation block, the missing status instruction and the ADR 724 act are the product every seat on
every team gets; the run measures them where finding 022 found the cost.

## Rider 4: finding 025's two follow-ups — the open lanes in the orientation block, and the push as an event

**Lanes:** `01M5RQQTBG` (orientation lists the open lanes), `01M5RQQ4T2` (a push is an event).
**Status:** pre-registered 2026-10-24, before either change has run on CooperBench. Run manifest:
[rider4-manifest.md](./rider4-manifest.md) (2026-10-25). **Read 2026-10-25 → [finding 026](../026-cooperbench-rider4-run.md):**
R4a 6 (part of it), R4b 18 (did not act); 20 of 20 pushes recorded, 4 acts sent (no watcher on the other 16).

**What changes.** (R4a) The one-call orientation block lists the open, unowned lanes on the project
as well as the held ones, and closes by saying that `lane_open` checks the new scope against every
lane and warns on overlap. Finding 025 found 9 board reads after the instructed first call (8
`lane_board`, 1 `team_status`), eight of them an agent reading the board right before `lane_open`.
(R4b) The daemon learns of a `git push` of a lane's branch and sends one directed act to the seats
waiting on that lane. Finding 025 found "pushed / fetch" the largest state-signal kind, 14 calls
($0.26), with no product event behind it.

**Read**, from the first complete musterd run on a build carrying the change over all 10 `core`
pairs, with the claim run's residue scripts unchanged:

| | Count | Finding 025 (`core`) |
| --- | --- | --- |
| R4a | board reads with `context = before first claim`, minus the instructed first `team_inbox_check` of each agent | 9 of 85 (claim run 7) |
| R4b | sends `is_signal` marks as pushed / fetch | 14 calls, $0.26 (claim run 10) |

**Verdict rule.** R4a **≤ 3** "the block answered the pre-open question", **≥ 8** "it did not";
between, "part of it", with the labelled rows. R4b **≤ 5** "the push event carried the signal",
**≥ 12** "it did not"; between, "part of it", with the bodies. Each rule stands alone, and the count
of ADR 724 acts and push acts delivered is reported beside them with no rule.

**Not gaming.** As riders 1–3: no instruction, hint or tool is added to any arm for it. The open
lanes in the block and the push act are the product every seat on every team gets.


## Rider 5: finding 026's two follow-ups — the push reaches the lanes that cover its files, and the pusher is told

**Lanes:** `01M5V4GEP0` (this pre-registration), `01M5V4H40C` (the ADR and product change),
`01M5V4HH6Z` (the run → finding 027); goal `coordination-cost`. **Status:** pre-registered 2026-10-25,
before the product change has landed or run on CooperBench. Run manifest:
[rider5-manifest.md](./rider5-manifest.md). **Read 2026-10-26 → [finding 027](../027-cooperbench-rider5-run.md):**
R5a 12 (did not act, at the bound), R5b 12 of 22 recorded pushes, 12 of 23 push commands (part of it on either), R5c 8 of 12 (did not act); the hook's line
reached the pusher 22 of 22 times; the 10 silent pushes all came after the partner's lane had ended. Decided by nick, 2026-10-25, in session ("audience 3, head
addition in, run it — go ahead").

**What changes.** Finding 026 read ADR 730 on the 10 `core` pairs: the hook reported 20 of 20 pushes
and the daemon recorded each, but it announced 4, because ADR 730 §3's audience — seats with an open
ADR 724 watch on the lane — was empty for 16 (the refused seat's own push never has one; a holder's push
before the partner's refusal or after the lane freed has none either). Three of the four announced
holders said it again by hand, because the hook tells the pusher nothing. Three product changes, one
ADR: (a) the audience becomes, beside the open watchers, every other seat owning a contending lane in
the same project whose scope **covers** a file the pushing lane **names** — the ADR 150 / 691 relation
the gate itself refuses on, so it exists before any refusal and survives the lane freeing (on the
revive board the day of the decision: 2 lane pairs, against 12 for any glob overlap); (b) the push
hook answers the pusher with one PostToolUse context line naming who was told, or that no other lane
covers the lane's files; (c) the ADR 691 refusal names the lane's last pushed head when one is
recorded, so a seat refused after the push already knows where the work is.

**Read**, from the first complete musterd run on a build carrying the ADR over all 10 `core` pairs,
with the claim run's residue scripts and rider 4's `rider4.py` unchanged:

| | Count | Finding 026 (`core`) | Finding 025 |
| --- | --- | --- | --- |
| R5a | sends `is_signal` marks as pushed / fetch (`sends.py`) | 18 calls, $0.35 | 14, $0.26 |
| R5b | recorded pushes of a lane's branch that fired at least one push act (`rider4.py`: pairs' `push_acts` by holder and head, over `git_pushes`) | 4 of 20 | — |
| R5c | announced pushers who then sent a hand pushed / fetch message anyway (`rider4.py`: a `hand_pushed_sends` entry with `push_acts_so_far ≥ 1`, over the holders in `push_acts`) | 3 of 4 | — |

**Verdict rule.** R5a **≤ 5** "the push event carried the signal", **≥ 12** "it did not"; between,
"part of it", with the bodies. R5b **≥ 80%** of recorded pushes "the audience is the one that was
missing", **≤ 40%** "it is not"; between, "part of it", with the three reasons of finding 026 re-counted.
R5c **≤ 25%** "the pusher's line stopped the repeat", **≥ 60%** "it did not"; between, "part of it",
with the bodies. Each rule stands alone. Reported beside them with no rule: the receiver's next move
after each push act (`receiver_next`), ADR 724 acts, status updates, pass, cost, and how many
refusals carried a pushed head.

**Not gaming.** As riders 1–4: no instruction, hint or tool is added to any arm for it. The wider
audience, the pusher's line and the head in the refusal are the product every seat on every team gets;
the hook command text does not change, so the arm's pinned settings do not either.
