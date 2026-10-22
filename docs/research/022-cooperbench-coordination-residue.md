# 022 — CooperBench: polling is gone; what is left is held-file talk and the protocol's own messages

> **Status:** 2026-10-22, lane 01M5JMCKWR (lazara). A diagnosis of the claim run's logs
> ([finding 021](./021-cooperbench-claim-run.md)), with finding 019's labels unchanged. No new run,
> and no model spend.
> **Result:** on `core`, musterd's coordination still costs about **$7.8 of $17.29**, but very little
> of it is polling any more. Three things remain. **(1)** A held-file refusal tells the agent to
> *ask* first, and agents do. Over all 20 pairs, after every one of the 29 refusals for a held file
> (16 on `core`, 13 on the new ten), the refused agent messaged or asked the holder, and none used
> the one-call `until_lane` wait. The gate's 21 other `denied` rows are a different refusal: a file
> no lane of theirs covers (ADR 150), not a hold. **(2)** CooperBench's own protocol messages (plan at the start, "Done"
> at the end) and musterd's status updates are about $2.2, and are mostly instructed. **(3)** State
> signals ("pushed", "you can edit now") fell from $1.22 to $0.69. That was finding 019's C, and the
> fixes already took about 40% of it.

## Question

Finding 021 measured 149 `team_send` calls on `core` after finding 019's fixes, and named them as
the next cost lever. What do they carry? And what else is left of musterd's coordination cost now
that the blocking wait and tool search are in?

## Method

Finding 019's labels, unchanged: `calls.py` and `cf.py` in
`pilot-runs/2026-10-21-pilot3/cost/`. One label per API call, with the cost of each call priced
from its own usage. The claim run's musterd streams (`claim-musterd-core`, `claim-musterd-new`) sit
beside pilot 3's (`p3-musterd`, `p3-team`). The extra splits (send kinds, episode contents, the tool
table) are in `pilot-runs/2026-10-22-claim/residue/`. The figures below are `core` unless a row says
otherwise, because `core` is what both runs share.

## Where musterd's `core` money goes now

| Bucket | Pilot 3 musterd | Claim run musterd | Pilot 3 team |
| --- | --- | --- | --- |
| Work (read, edit, test, bash) | $7.14 | $5.95 | $9.00 |
| musterd tools, waits, gate refusals | $9.34 | **$4.77** | $0.12 |
| Messages (`team_send`; coop CLI for team) | $3.39 | $2.18 | $0.60 |
| git | $4.03 | $3.01 | $3.39 |
| `ToolSearch`, text-only, other | $0.69 | $1.38 | $0.65 |
| **Total** | **$24.59** | **$17.29** | **$13.76** |

Coordination (the musterd-tool, message and `ToolSearch` rows) is about **$7.8** against the team
harness's under $1. musterd's total is only $3.5 above team's because its agents spend $3 less on
work: in the team arm, the lead and the member run a mandatory integration pass.

## What the musterd-tool money is

| Call | Pilot 3 | Claim run |
| --- | --- | --- |
| `team_inbox_check` without `wait` | 165 calls, $4.13 | 39, $1.22 |
| `team_inbox_check {wait}` | did not exist | 65, $1.20 |
| `sleep` in Bash | 55, $1.34 | 1, $0.02 |
| `lane_board` / `team_status` | 61, $1.39 | 41, $0.73 |
| Edit refused by the gate | 30, $1.01 | 33, $0.91 |
| `ToolSearch` | none (tool search off) | 44, $0.84 |
| lane open / update / resolve / release / handoff / submit | 53, $1.44 | 36, $0.70 |

**Polling is gone.** Inside wait episodes (019's definition: two or more wait-shaped calls in a row),
plain inbox checks fell from 66 to 0, sleeps from 40 to 1, and `lane_board` from 37 to 9. What is
left inside an episode is **repeated blocking waits** (31 calls, $0.56) and the git fetches between
them. Agents asked for `wait: 45` (37 times), and some asked for 60, 90, 120 or 180 seconds. The
tool caps one wait at 50 s (`MAX_INBOX_WAIT_MS`, kept under the harness's MCP tool timeout), so a
long wait is several calls. Each one costs about $0.018.

## What the sends carry

| Kind (`core`) | Pilot 3 | Claim run |
| --- | --- | --- |
| State signal: pushed/fetch, lane done, merged, ETA (019's `is_signal`) | 47 calls, $1.22 | 34, $0.69 |
| Status update, not a signal | 43, $1.16 | 40, $0.94 |
| Message, not a signal or a plan | 40, $1.10 | 36, $0.75 |
| Plan / scope ("I plan to modify …") | 41, $0.98 | 26, $0.47 |
| `request_help` / `accept` / `handoff` | 7, $0.18 | 5, $0.10 |

- **The plan and "Done" messages are the protocol.** The agents' instructions are CooperBench's coop
  protocol, kept byte-identical for comparability. Step 1 sends the plan, and the last step sends
  "Done. I changed: …". They are not musterd's to remove inside this benchmark.
- **Status updates are musterd's own instruction** ("report status as you work"). In a two-seat team
  where the partner is messaged directly, the start and finish updates mostly repeat the direct message.
  At $0.94 they are worth knowing about, and not worth a product change for a two-agent case.
- **State signals are what fix C was for**, and the fixes already took about 40% of their cost. They
  are split by kind below.

### State signals by kind, and what already carries each

Calls that 019's `is_signal` marks, split by a second keyword pass (`residue/sends.py`, first match
wins, in the row order below). Each cell is calls and dollars.

| Kind | `core` | New ten |
| --- | --- | --- |
| Pushed / fetch ("pushed to `team/agent2`") | 10, $0.20 | 14, $0.32 |
| Merged / complete / submitted | 16, $0.34 | 8, $0.19 |
| Lane done / you can edit | 4, $0.08 | 8, $0.18 |
| Waiting / ETA | 2, $0.04 | 2, $0.04 |
| Thanks / ack | 1, $0.02 | none |
| Other | 1, $0.01 | 3, $0.05 |
| **All signals** | **34, $0.69** | **35, $0.78** |
| Run cost as run → with every signal call dropped (019's C counterfactual) | $17.29 → **$16.60** | $18.70 → **$17.92** |

What already carries each kind, or the gap:

- **Pushed / fetch: a gap.** musterd never sees a push. ADR 697 learns a lane's branch from the
  agent's edits, and fix C hands that branch over when the lane resolves. A partner who pushes
  mid-lane, so the other can build on it, has no product event to carry that, so a message is the
  only way. This is the largest kind left.
- **Merged / complete / submitted:** the lane's resolve carries "my part is done" (a team-wide
  broadcast, and `until_lane` wakes on it). The rest is the protocol's closing "Done. I changed: …",
  which is not musterd's to remove here.
- **Lane done / you can edit:** carried. A lane resolving releases its hold, and
  `team_inbox_check {wait, until_lane}` wakes the waiting partner with the holder's branch (fix C).
  Agents sent these anyway because the held-file refusal sent them to ask (next section, fixed in
  #3219).
- **Waiting / ETA:** carried. The same `until_lane` wait replaces asking "ETA?", and the refusal now
  names it.
- **Thanks / ack:** no product state applies, and none should. At $0.02 it is not worth a change.
- **Plan / scope:** CooperBench's protocol, step 1. Kept byte-identical across arms.

## The gap that is musterd's: a held file says "ask"

| ADR 691 / 697 at the gate | Pilot 3 (10 pairs) | Claim run (20 pairs) |
| --- | --- | --- |
| Edits refused: file held (ADR 691) | 18 | **29** (16 `core`, 13 new) |
| Edits refused: no lane of theirs covers the file (ADR 150, not a hold) | 7 | 21 |
| Edits refused once: hand-over (ADR 697) | 7 | 19 |
| Hand-over followed by a merge of the holder's branch before the next edit | 1 of 7 | **8 of 19 (42%)** |
| After a held refusal, the refused agent's next act (`readout.py`, one per held refusal) | 9 messaged, 7 `request_help`, 2 retried (of 18) | **25 messaged, 4 `request_help` (of 29)** |
| …used `team_inbox_check {wait, until_lane}` | (did not exist) | **0** |

The refusal text (`packages/server/src/protocol/gate.ts`, held case) reads:
*"'path' is held by agent1 (lane "…", named it first, since …) — ask them to hand it off or narrow
their lane, wait for that lane to finish, or split the work by handoff."* The first instruction is
**ask**, and agents follow it. "Wait for that lane to finish" names neither the lane id nor the
one-call wait, so the agent has nothing to call. The samples read the same way: *"Can you release
your lane or hand off src/jinja2/ext.py? The system is blocking my edits because you still hold the
file."*

ADR 697's own rule (a hand-over is followed by a merge at least half the time, with at least 4
hand-overs) still fails, at 42%. It is up from 1 of 7 in pilot 3.

## What it changes

1. **Next product change: the held-file refusal leads with the wait.** Name the holder's lane id
   and the call, `team_inbox_check {wait: 45, until_lane: <id>}`, which wakes with the holder's
   branch when the lane resolves (fix C). Keep "ask them to hand it off" as the second option. This
   costs nothing for a real team, and it is the one place where musterd's own words send an agent to
   message. It is a gate-text change, so it needs a lane, not a run. Re-measured on the next run:
   messages after a held refusal, and `until_lane` use. _(Landed 2026-10-22 as #3219, lane
   01M5JMN1X5.)_
2. **The one signal kind no product state carries: "pushed".** A push mid-lane is invisible to
   musterd, so agents announce it ($0.20 on `core`, $0.32 on the new ten). Carrying it would mean the
   daemon seeing a lane's branch move (ADR 697 already records the branch from edits), and waking a
   partner who waits on that lane. This is worth a design note before any lane: it is a new event,
   not a wording change, and it is small money here.
3. **Not worth doing for this benchmark:** removing status updates or the protocol's plan/"Done"
   messages (instructed, and the protocol must match the other arms); raising the 50 s wait cap
   (about $0.56 on `core`, and bounded by the harness's tool timeout).
4. **The cost floor, honestly:** with the gate-text fix, the reachable saving is perhaps a further
   $0.5–1 on `core`, out of the $3.5 left above the team arm. musterd's remaining premium over
   CooperBench's own harness is mostly the lanes and gate doing their job (opening lanes, refusals,
   hand-overs), plus messages the benchmark's protocol requires.

## Limits

Ten `core` pairs, compared across two runs on different days. The send kinds come from keyword
matches (019's regexes, plus a second keyword pass for the kinds). "What the refused agent did next"
is `readout.py`'s heuristic: the next musterd act after the refusal.

Data: `docs/research/cooperbench/pilot-runs/2026-10-22-claim/residue/` (`residue.txt`,
`sends.json` and the four scripts that made them).
