# CooperBench rider 7 run: pre-registration

**Lane:** `01M6M3YG37` (this page, the arm change and the run), goal `coordination-cost`, asked by nick.
**Status:** pre-registered 2026-11-04, before the arm change has landed and before any pair ran. Run 2026-11-04 21:04–21:39Z: pre-flight PASS, the smoke pair (step 4) stopped by the author at $17.80 of
the $25 stop → [finding 031](../031-cooperbench-rider7-smoke.md); no measured pair ran, no rule read. Nothing
below changes once a measured pair has run; what the run teaches goes in the finding, not here.
**CooperBench:** `63b9d44`. **Before this:** [rider 6 run](./rider6-manifest.md) → [finding
028](../028-cooperbench-rider6-run.md), whose R6b this run answers; the [design
note](../../design/cooperbench-act-lane-wake.md) (2026-10-29) and its amended gate; the act lane's own
reads on revive, [finding 029](../029-act-lane-read.md) and [finding 030](../030-act-lane-reread.md).

## Why

Finding 028 found the one rule aimed at the money unmoved: wait-mode `team_inbox_check` calls went from
82 to 90 while every push was announced, and 94 of 98 waits returned an act. The waits were the agents
taking turns, and every turn is paid for twice — once to read the act, once to answer it. ADR 735's act
lane is the inverted loop the product already ships: the seat ends its turn and the host resumes it on
the next directed act. The design note held rider 7 until the lane read "acted" on revive. Finding 030
read "part of it", and showed what held revive's seats: attended sessions (67–91% of waited time) and
the hourly cap on a burst, neither of which a CooperBench pair has. nick amended the gate on 2026-11-04
to "the lane wakes an unattended seat within 2 min", which finding 030 supports (11 of 20 waits ≤ 4.1
min once unattended, 9 of them ≤ 2.2 min), and chose to run.

[Rider 7](./riders.md#rider-7-finding-028s-loop--the-musterd-arm-on-the-act-lane-where-a-seat-ends-its-turn-and-the-host-wakes-it-on-the-next-act)
pre-registers the reads and their verdict rules. They are quoted here so the two documents cannot drift:

| | Count | Finding 028 (`core`) | Acted | Did not |
| --- | --- | --- | --- | --- |
| R7a | turns spent waiting: wait-mode `team_inbox_check` calls plus wakes | 90 (+ 0 wakes) | **≤ 55** | **≥ 75** |
| R7b | model dollars, 10 pairs, first call plus every wake | $18.45 | **≤ $15.00** | **≥ $18.00** |
| R7c | act→wake wait, median over wakes with a `waited_ms` | — | **≤ 2 min** | **≥ 15 min** |

Between the bounds: "part of it". A run where R7c reads "did not" voids R7a and R7b as reads of the
lane. Each rule stands alone otherwise. Beside them, with no rule: wakes per pair, fresh vs resumed,
plain `team_inbox_check` calls, `ToolSearch` calls, pushes recorded and announced, board reads, status
updates, pairs that hit the 7,200 s cap, pass, conflicts.

## Question

On the 10 `core` pairs, with the seats on the act lane and the arm's "wait in one call" sentence
removed, do the turns spent waiting go away, does the run cost less, and does the host wake a seat
within minutes of the act? Pass rate and conflicts are reported, with no claim (findings 018 and 021).

## Arm

One arm, musterd only, on the act lane:

```
cooperbench run -n r7-musterd -s core -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval
```

with `MUSTERD_ARM_LANE=act` in the run's environment, which is the one switch the adapter reads.
`claude_code_musterd`, Claude Code **2.1.307**, `claude-sonnet-4-5`, gate in `block` posture over `**`,
every ADR in force on `main` at the deploy; `MUSTERD_REF` records the commit.

**The treatment**, each piece a change to the arm and none to the product:

| Piece | Rider 6 | Rider 7 | Where |
| --- | --- | --- | --- |
| Team residency policy | defaults (`both`, cap 2, 300 s, 256 KiB, `reply-only`) | `lane act`, `hourly_cap 60`, `timeout 60m`, `transcript_max 256 MiB`, `tool_policy seat-policy` (`team.py: ACT_LANE_POLICY`; exact-match resume has no CLI knob and stays at the team default, so a wake resumes by the ADR 131 ladder from the capture hook) | `team.py`, `musterd residency policy` on the pair's team |
| Enrollment | none | each seat enrolled from the container (`residency on --seat <agent> --workspace /workspace/repo`, authorized by the pair's admin binding), `musterd host --interval 10 --timeout 3600 --no-provision --no-gateway` running in the container | `adapter.py` |
| Instruction | "When you must wait for a partner, wait in ONE call — `team_inbox_check` with `wait: 45` … Never poll" and the `until_lane` wait after a held refusal | both sentences removed; the product's guidance ("end your turn; the host resumes you on the next directed act") stands | `prompt.py` (`musterd_block(lane="act")`) |
| Container settings | the three hooks | the three hooks, the project-local session-capture and session-end hooks, and `permissions.allow` for Edit, Write, Bash and `mcp__musterd` (the ADR 261 floor), written to `.claude/settings.local.json` so a wake reads them (`--setting-sources project,local`) | `config.py` |
| Run shape | one `claude -p`, patch read at exit | the first `claude -p` ends at the agent's first idle turn; the adapter then polls every 30 s until this seat has written `patch.txt` and has no unread directed act (`report delivery`) for 300 s running, or 7,200 s from the first call, as today; then reads `patch.txt`. Lane state is not the end condition: an agent that never resolves its lane would otherwise run every pair to the cap | `adapter.py` |
| Cost | the first call's `total_cost_usd` | the same plus every wake's `cost_usd` from `residency.wake_cost` rows, per agent | `readout.py` / `rider7.py` |

The first call and every wake run with the same permission posture (`default` mode, the floor, no
skip-permissions flag), the same MCP server and the same hooks. `.claude/` joins `.musterd/` in
`.git/info/exclude` so neither reaches the scored patch.

## Tasks

CooperBench's 10 `core` pairs ([pilot manifest](./pilot-manifest.md#tasks)), the pairs findings 022,
025–028 read, so the comparison is pair for pair.

## Reads

Each count is read once, from the first complete run, over the 10 `core` pairs, with the claim run's
residue scripts, `rider5.py` and `mtools.py` unchanged, and `rider7.py` written before the run. R7a is
`mtools.py`'s `musterd:team_inbox_check (wait)` line plus `rider7.json`'s `wakes`; R7b is
`rider7.json`'s `cost_usd_total`; R7c is `rider7.json`'s `waited_median_s`. "Part of it" on R7a is
read by hand from the streams and the daemon log: for each remaining wait call, whether the agent
was told to end its turn and did not, or was mid-task.

## Errors

As in the rider 6 run: an error (container or MCP startup failure, enrollment or host failure, evaluator
error, API outage or usage limit, an unreachable shared remote) is re-run once under a new run name with
its reason recorded; a failed score is never re-run. Three errors in the first three pairs stop the arm.
A pair where no wake was ever due is not an error (the agents may have finished in one turn each); a
pair where a wake was due and the host never leased it is an error. An API usage limit `spend_guard.py`
detects stops the run; the pairs that ran are reported as a partial run with that stated.

## Procedure

On `musterd-cooperbench`, in one session, under `run_arms.py` with the hard stop below.

1. **Deploy** from `main` at or after this lane's merge, Claude Code pinned to 2.1.307. After the
   deploy: `useradd smoke`, `chmod 1777` the swe_agent `trajectories` directory, the `dataset` symlink.
2. **API check:** one one-word `claude -p` call returns without error.
3. **Smokes, under $0.05, as the `smoke` user, host `musterd` on `PATH`:** `gate_smoke.py` and
   `hold_smoke_697.py` both PASS, no deaf warning.
4. **One smoke pair** (`pallets_click` 2068, features 1 and 2, `MUSTERD_ARM_LANE=act`), about $2: it
   must show at least one wake leased and resumed in each container's `host.log`, a `residency.wake`
   row per wake in the pair's database, and both patches read. It is not scored and not read. A smoke
   pair that shows no wake, or a wake that never occupied, stops the run until the cause is fixed and
   the fix is in `main`.
5. **Pull** the ten images, then **run the arm** `-c 3`, `--no-auto-eval`, then `cooperbench eval
   --backend docker`, under `run_arms.py --cap 24.80`.
6. **Re-run errors once,** then copy `readout.json`, the run log, each pair's `host.log`, the residue
   scripts' output, `rider5.json` and `rider7.json` into `docs/research/cooperbench/pilot-runs/<date>-rider7/`
   (`git status` must show the `.log` files staged), and `fly machine stop`.
7. **Read R7a, R7b and R7c** under the rules above, then write finding 031.

## Spend

| Item | Estimate |
| --- | --- |
| API check and smokes | under $0.10 |
| smoke pair | about $2 |
| musterd arm, 10 `core` pairs (finding 028 $18.45; wakes replace waits, so about the same) | $16–21 |
| Fly, about 1.5 h | under $4 |
| **Total model spend** | **about $20 (range $18–23)** |

**Hard stop: $25 of model spend**, counted from step 2, including the smoke pair and error re-runs.

## Decisions

| Decision | Answer |
| --- | --- |
| Amend the gate rather than override it or hold | nick, 2026-11-04, in session ("go with the third, amend the gate and run it") |
| Gate: the lane wakes an unattended seat within 2 min | lazara's proposal, same session, from finding 030's 11 unattended waits |
| R7a counts wakes as turns | the design note (2026-10-29), kept |
| R7b bounds $15 / $18 against $18.45 | this manifest; no figure asked |
| R7c voids the other two when it reads "did not" | this manifest: a seat that was not woken measured the cap |
| Spend | ~$20, hard stop $25 (nick, same session) |
| Pass rate | reported, no claim (this manifest) |
| Finding number | 031 |
