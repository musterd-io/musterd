# CooperBench on the act lane: what rider 7 needs

> **Status:** design note, 2026-10-29, lane `01M62YTZDX` (lazara), asked for by nick. No run, no
> spend. **Held:** rider 7 is built and pre-registered only if the act-lane re-read on revive
> ([manifest](../research/act-lane-manifest.md), "Re-read on the ADR 753 build", read 2026-11-04)
> reads R8a "acted". If R8a reads "did not act", the act lane is not ready, and rider 7 would only
> measure the same turn-taking again. This note then freezes as the record of why.

## Why

[Finding 028](../research/028-cooperbench-rider6-run.md) R6b: the musterd arm's 90 wait-mode
`team_inbox_check` calls were not empty polls. 94 of 98 waits returned an act. A wait is a turn
boundary, and an arriving act costs the receiver a turn to read and a turn to answer, whoever wrote
it. The loop itself is the cost. The fix 028 points at is the inverted loop: the agent ends its turn
and the host resumes it on an act. That is ADR 735's act lane, which the product already ships and
already tells a seat about (`guidance.ts`: "when you have nothing to do, end your turn. The host
resumes you on the next directed act").

On revive the act lane missed its first read ([finding 029](../research/029-act-lane-read.md):
median 2.9 h from act to wake, against 4.5 s on the launch lanes). The cause was the daemon's
gates, which ADR 753 now records. The re-read decides whether the lane is worth putting a benchmark
on.

## What is already team policy

Each CooperBench pair runs on a fresh team (`team.py`), so the arm sets these as any team would. No
product change is needed:

| Knob | Default | Rider 7 | Why |
| --- | --- | --- | --- |
| `lane` | `launch` | `act` | the inverted loop (ADR 735) |
| `tool_policy` | `reply-only` | `seat-policy` | a woken agent must edit and run git; `seat-policy` defers to the workspace's settings (ADR 131 §6) and never passes a skip-permissions flag |
| `timeout_ms` | 300 s | 3,600 s (the max) | a resumed turn may run a full test suite |
| `transcript_max_bytes` | 256 KiB | up to 256 MiB | past the bound a wake starts fresh, and an agent waiting on its partner is past 256 KiB; a fresh start loses its working context |
| `exact_match_resume` | off | on | a threaded reply resumes the same transcript (ADR 210) instead of the portable fresh start (ADR 209) |
| `hourly_cap` | 2 | 60 (the max) | a pair takes turns many times in an hour |
| `musterd host --interval` | 10 s | 10 s | the host's poll; it bounds act→wake latency from below |

## What the arm must change

None of these is a product change. Each one does change the arm, so the manifest has to name it.

1. **The run shape.** Today the adapter makes one `claude -p` call and reads the patch when it exits
   (`adapter.py` step 4). On the act lane, the first call ends at the agent's first idle turn, and
   `musterd host` runs in the container and resumes the seat on each act. The adapter needs an end
   condition in place of process exit. Two options:
   - **(a)** both seats' lanes are `done` and neither seat has an unread directed act;
   - **(b)** a wall clock of the same 7,200 s the arm has today.

   **(a)** is the honest one, with **(b)** as its cap.
2. **Permissions without the skip flag.** CooperBench's own command runs Claude Code with
   `--dangerously-skip-permissions` (the containers set `IS_SANDBOX=1`). A wake never passes that
   flag, so under `seat-policy` the container's settings (`config.claude_settings`) need a
   `permissions.allow` list for the tools the task uses: Edit, Write, Bash. That is the ADR 261
   permission floor a real workspace carries. Both the first call and every wake read it, so the
   two run with one posture.
3. **The instruction.** `prompt.py` tells the agent to wait in one blocking `team_inbox_check` call.
   That sentence is the arm's, not the product's. On the act lane it contradicts the product's
   guidance, which says to end the turn. Rider 7 removes the sentence and leaves the guidance in
   force. That is a change between arms, and the manifest names it as the treatment.
4. **Cost accounting.** Each wake is its own `claude` process with its own `total_cost_usd`. The
   readout sums the first call and every wake run per agent. The daemon's `residency.wake_cost` rows
   are the cross-check (ADR 252).

## What rider 7 would read

Rider 7 runs on the 10 `core` pairs, against rider 6 (finding 028) on the same pairs. The bounds get
frozen in the manifest before any pair runs. The figures below are only where they would start:

- **R7-turns:** turns spent waiting. On rider 6 these are wait-mode `team_inbox_check` calls (90). On
  rider 7, the same calls plus the wakes. A wake is a turn too, so the rule counts it, not only the
  calls that went away.
- **R7-cost:** dollars per pair against rider 6's $18.45 per 10 pairs, with the wake runs summed.
- **R7-latency:** act→wake per wake, from the report's `waited_ms` and `holds` (ADR 749, 753). It is
  read beside the other two: a slow wake costs no tokens, but it does cost wall clock, and the 7,200 s
  cap turns that into a loss.
- Pass and conflicts are recorded, with no claim, as in riders 4 to 6.

Spend: about $19 for the run, with the same hard stop as rider 6. Spend waits on nick's approval. A
smoke on one pair (about $2) comes first, and only after the API key's limit lifts (2026-11-01, per
[finding 023](../research/023-cooperbench-coordination-run.md)).

## Not gaming

Every knob in the policy table is a team setting any team has. The permission list is the floor a
real workspace carries. The instruction change removes a sentence the arm added and leaves the
product's own guidance in force. Nothing in this note adds a tool, hint or mechanism that exists only
for the benchmark.
