# 019 — Where musterd's extra CooperBench cost goes: polling and a tool surface we chose to load

> **Status:** 2026-10-21, lane 01M5GVGTFH (lazara), asked for by nick. A diagnosis of pilot 3's logs
> ([finding 017](./017-cooperbench-pilot-3.md)). No new runs, and no model spend.
> **Result:** musterd's two agents cost $24.59 against $10.83 less for CooperBench's own two-agent
> harness ($13.76). Two causes explain most of that gap. **(A)** Our harness turned Claude Code's
> tool search off, so all 31 musterd tool schemas (about 16k tokens) sat in every model call.
> **(B)** An agent waiting for its partner had no way to block, so it polled: 51 waits, 257 calls.
> Removing both would bring musterd to about **1.2× the team arm** instead of 1.8×. These are
> counterfactual estimates, to rank the fixes. They are not a measured result.

## Question

[Finding 018](./018-cooperbench-solo-reference.md) put musterd at 4× the cost of one agent. Part of
that is the price of using two agents at all: CooperBench's team arm, with no musterd, cost 2.25×
solo. The part musterd adds is the gap to the team arm: **1.8×, $10.83 over ten pairs**. Which
steps make up that $10.83, and which of them could the product remove?

## Method

Each agent's Claude Code `stream-json` log, pulled from the run volume. Every model call is grouped
by message id and costed from its own usage at `claude-sonnet-4-5` list prices. The stream reports
only placeholder output tokens per message, so each session's real output-token total is spread over
its calls by how much each call emitted. With that, the per-call costs add up **to the cent** to the
reported spend of all three arms ($24.59, $13.76, $6.12). Each call is labelled by the tool it called
(musterd tool, `sleep` loop, git fetch or merge of the partner, edit, read, test…). Each session is
split into three phases at its first and last successful edit. Scripts and readout:
[`pilot-runs/2026-10-21-pilot3/cost/`](./cooperbench/pilot-runs/2026-10-21-pilot3/cost/)
(`LOGS=/data/runs/logs python3 report.py`).

## Result

Cost is almost all cache reads: each call re-reads the whole context. So **cost ≈ calls × context**,
and musterd is higher on both factors: 938 calls against 635, at 62k tokens of mean context against
42k.

| Phase | musterd calls | musterd $ | team calls | team $ | solo $ |
| --- | --- | --- | --- | --- | --- |
| Before the first edit | 293 | **7.52** | 84 | 1.80 | 0.92 |
| Editing | 150 | 4.28 | 386 | 8.56 | 3.46 |
| After the last edit | 495 | **12.78** | 165 | 3.41 | 1.74 |
| **Total** | 938 | **24.59** | 635 | 13.76 | 6.12 |

musterd's agents spend *less* while editing. Its waste sits on either side of the editing. Before the
first edit, the second agent waits for the partner who holds the shared file. After the last edit,
both wait for each other's push so they can merge.

### A — the tool surface: +16k tokens in every call (about $4.2–4.6)

The first call of a musterd session carries 39.6k tokens of context, against 23.6k for the team arm,
even though musterd's task prompt is the shorter one. The difference is the musterd MCP surface:
31 tool schemas plus the server's instructions, loaded up front. Claude Code would normally defer
those schemas behind `ToolSearch`, which it did in the team arm. Our harness sets
`ENABLE_TOOL_SEARCH=false` ([README](./cooperbench/README.md)), on purpose. It works around a real
product gap: **a seat joins only on its first musterd tool call**. With tool search on, that first
call is `ToolSearch`, and until a musterd call lands the edit gate fails open and the interrupt hook
is deaf. The workaround closed that gap and made every call carry the full surface.

musterd already marks its four hot tools (`team_join`, `team_inbox_check`, `team_send`,
`team_status`) to load up front even with tool search on (`HOT_TOOLS`, lane 01M4S53E79). Joining the
seat at session start would let tool search stay on. Every call would then carry only the hot tools
and the instructions, estimated here at about 4k tokens. That is not yet measured; the fix lane
measures it.

### B — waiting by polling: 51 waits, 257 calls (about $4.8)

A wait is two or more calls in a row of `team_inbox_check`, `lane_board`, `team_status` or
`sleep N`, with the git fetches in between. 124 of the 198 inbox checks (63%) returned no new
message. The agents wrote their own wait loops: `sleep 10 && git fetch team &&
git log team/agent2 --oneline -3`, and `for i in {1..10}; do sleep …; git fetch team …`. Each turn of a loop is a
full model call at about 60k tokens of context.

**The waiting itself is the design working.** It is how the hold serialises the shared file, and
how each agent merges its partner's finished work before it submits, which is where musterd's zero
coordination losses come from (finding 017). The cost lies in *how* the agents wait. The `musterd`
CLI has a blocking `inbox --wait`, but the MCP surface has no blocking wait, so an MCP agent can
only poll. With one blocking call per wait, 206 of the 257 calls go.

### C — messages that carry state the product already has (about $1.2 of $3.5)

132 `team_send` calls (about $3.5) carry a state change rather than a plan: "pushed, fetch me",
"lane resolved, you can edit core.py now", "I'm blocked, what's your ETA?", "merged yours, done".
musterd already knows when a lane resolves and when a hold is released. A wait that wakes on those
events would make many of these messages unnecessary. This estimate is the least certain of the
three: the label comes from a keyword match, and agents may keep announcing anyway.

### What it does not come from

- **Gate refusals:** 30 refused edits, $0.87. Small, and each one is the gate doing its job.
- **Merging twice:** fetching and merging the partner costs $1.15 against the team arm's $0.57.
  Real but small.

## Counterfactual

Each estimate removes the named calls, or trims the surface from every remaining call, and leaves
everything else as it ran. It ignores the fact that removed calls would also shrink later context, so
it **understates** the saving. It assumes agents would otherwise behave the same, which a re-run has
to test.

| Change | musterd $ | × team | × solo |
| --- | --- | --- | --- |
| As run | 24.59 | 1.79 | 4.02 |
| A: surface 16k → 4k | 20.38 | 1.48 | 3.33 |
| B: one blocking call per wait | 19.75 | 1.44 | 3.23 |
| C: drop state-signal sends | 23.37 | 1.70 | 3.82 |
| **A + B** | **16.29** | **1.18** | 2.66 |
| A + B + C | 15.24 | 1.11 | 2.49 |

## What it changes

1. **Two product fixes, both for every musterd user, not just this benchmark.** (A) A seat joins at
   session start, not on its first musterd call. That also closes the ungated window for real users,
   and lets tool search stay on. (B) A blocking wait on the MCP surface, which wakes on an act
   addressed to the seat or on the release of a hold or lane it is waiting on. B also covers most of
   C. Each is its own lane. Whether either needs an ADR is that lane's call: B adds a tool, or a
   parameter on an existing one.
2. **No re-run until both have landed.** The next measured run (the N=20 re-run in finding 018's
   "What it changes") should run on the build with A and B, so its cost number holds after it is
   published.
3. **Two agents still cost about 2.5× one, even at best.** That is the team arm's own ratio. musterd
   can approach the team arm's cost, not solo's.

## Limits

N = 10 pairs, one model, one run. The labels come from tool names and keyword matches. A is
estimated, not measured. The counterfactuals rank the fixes and estimate their size. They do not
replace the re-run.
