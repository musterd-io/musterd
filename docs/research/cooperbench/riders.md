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

**Lane:** `01M5N3THX3`. **Status:** pre-registered 2026-10-23, before ADR 724 is built.

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
