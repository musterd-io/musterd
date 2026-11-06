# 036 — Where musterd's 2.8× goes on the flash run: coordination turns and a heavier preamble, not duplicated feature work

> **Status:** 2026-11-06, lane 01M6S2NF8R (lazara), asked for by nick in session ("yes go ahead",
> 2026-11-06). **No model spend**: log arithmetic over [finding 035](./035-cooperbench-flash-comparison.md)'s
> run. Not pre-registered — this is a descriptive split that names what the next pre-registered
> cost run tests; it reads no rule and moves no verdict. Script:
> [`costsplit.py`](../../scripts/research/cooperbench/costsplit.py); output:
> [`costsplit.json`](./cooperbench/pilot-runs/2026-11-06-flash/costsplit.json). The stream
> transcripts it reads are on `cb-run-2`'s volume (`/data/runs/logs/flash2-*`), copied out once with
> the machine started for ~10 min and stopped again; they are not committed.

## Question

Finding 035: musterd's two agents pass as often as one (38 vs 37 of 50) at 2.8× the model dollars
($24.64 vs $8.74). Before choosing what to change, where does the $15.90 gap go?

## Method

Every Claude Code session's `agent*_stream.jsonl` (solo 50, team 100, musterd 100 incl. the re-run
pair). Each API call (one message id) is priced from its own `usage`; the call's price goes to the
tool(s) it issued, split evenly over parallel tool calls, or to `final` if it issued none. Bash
commands are classified by regex (git fetch/merge/push → integrate; pytest and builds → test;
grep/cat/sed -n → read; sed -i/heredoc writes → edit).

Two corrections made the totals reconcile to the cent for solo and musterd (team: within $0.10):

- **Prices.** Fitting `result.json`'s 248 per-agent costs on their four token counts gives exactly
  $4 in / $20 out / **$0.20 cache read** / $5 cache write per MTok (max error 1e-15). Cache reads bill
  at 0.05× input under Claude Code 2.1.307, not the 0.1× assumed in earlier findings' estimates.
- **Output tokens.** Input-side tokens in the stream match `result.json` in 247 of 248 sessions, but
  stream messages carry a partial output count. Each session's true output total is spread over its
  calls in proportion to those partial counts. **Per-call output is therefore approximate**; session
  and arm totals are exact.

"Issued" attribution charges a call's whole price — including the context it re-reads and any
reasoning about the code — to the tool it chose. It says what the agent was *doing* on that turn,
not that all of the cost was coordination overhead.

## Results

| Category (issued $) | solo | team | musterd | musterd − solo |
| --- | --- | --- | --- | --- |
| **coordinate — musterd tools** | — | — | **$9.59** (10.7 calls/pair) | **+$9.59** |
| final answer (no tool) | $3.06 | $4.44 | $5.88 | +$2.82 |
| integrate — git fetch/merge/push | $0.00 | $0.00 | $2.57 (4.1/pair) | +$2.57 |
| read / search | $2.69 | $4.64 | $2.77 | +$0.08 |
| test / build | $1.72 | $3.11 | $1.97 | +$0.25 |
| edit | $1.14 | $3.33 | $1.36 | +$0.22 |
| other, git inspect, wait | $0.12 | $0.74 | $0.51 | +$0.39 |
| **total** | **$8.74** | **$16.15** (priced $16.25: one session's stream reports 12k more cache-read tokens than its result.json) | **$24.64** | **+$15.90** |
| calls per pair | 6.3 | 14.2 | 25.0 | |
| first-call context (median) | 18.3k tok | 18.6k tok | 25.4k tok | +7.1k |

Within coordination, by tool (issued $, calls/pair): `team_inbox_check` **$5.92 / 5.3**, `team_send`
$1.74 / 2.5, `lane_open` $0.84 / 1.2, `lane_update` $0.39 / 0.6, `lane_resolve` $0.36 / 0.5,
`lane_board` $0.32 / 0.4. Of the 336 inbox checks, **100 are each session's first call** (the prompt makes
`team_inbox_check` the first action): **$3.14** of the $5.92. A session's first call carries the
one-time write of its whole uncached context, and some call would pay it whatever tool it issued, so
that $3.14 is mostly the preamble's cost (below), not the inbox check's. The other 236 are **218
wait-mode checks ($2.61)** and 18 plain reads ($0.17).

**Cross-cut — the larger preamble.** musterd's sessions start 7.1k tokens heavier (its MCP tools and
guidance). Written once per session at $5/MTok and re-read on every later call at $0.20, that is
**$3.54 + $1.64 = $5.18** across the arm. It sits *inside* the categories above, not beside them.

**Integration is done by both agents.** In all 49 attempt-2 pairs both agents ran fetch/merge/push.

## What it says

1. **The feature work is not duplicated.** Read + test + edit cost $6.10 in musterd against $5.55 in
   solo: two agents splitting two features spend about what one agent spends doing both. The team
   harness, by contrast, spends $11.08 there — twice solo.
2. **The gap is turns, not tokens per turn.** musterd makes 4× solo's calls per pair (25.0 vs 6.3),
   and every call re-reads a context that starts 7.1k tokens larger. Coordination calls are 43% of
   musterd's calls (10.7 of 25.0) and 39% of its dollars.
3. **Waiting is a smaller line than the tool total suggests:** 218 wait-mode inbox checks, 4.4 per
   pair, cost $2.61 (11% of the arm). The rest of the inbox line is the first call's preamble write.
4. **One integrator instead of two would save little** — at most about half of $2.57, ~5% of the arm.
   This is smaller than the guess in the session plan that opened this lane; it goes down the list.

## Candidates for the cost run, by ceiling

Ceilings are upper bounds from this split, not predictions; they overlap.

| Candidate | Ceiling on flash | Risk recorded elsewhere |
| --- | --- | --- |
| Fewer wait turns (one wait that returns the partner's push, not repeated checks) | ≲ $2.6 (11%) | Finding 034: telling the seat to *end its turn* when waiting deadlocked 10 of 10 pairs — the fix must keep the seat in one blocking call, not end it |
| Smaller preamble (the 7.1k-token difference; its parts are not split here) | ≲ $5.2 (21%) | ADR 741 made lane tools always-load for latency (ToolSearch detours cost $105 in a week); a deferred tool costs a ToolSearch turn when needed |
| Fewer coordination writes (`team_send` 2.5/pair, `lane_update` 0.6) | ≲ $2.1 (9%) | Finding 025: the status updates dropped once guidance stopped asking; the remaining sends carry hand-off content |
| One integrator | ≲ $1.3 (5%) | Team harness's lead-integrator design lost 28 pairs to no integration (finding 035) |

Neither ceiling is reachable whole: the preamble holds the tools the seats do use, and the waits
are how the pair hears its partner. The next lane (01M6S2NP0X, cost-fix pre-registration) sizes the
preamble's parts and decides what to test, developed on the 10 `core` pairs only, with `flash` read
once at the end.

## Limits

- One run, one model (Opus 5.5), one harness version. The split is per call, not per token: a call
  that issues `team_inbox_check` and then reasons about code is all charged to coordination.
- Per-call output is apportioned, not observed (above). Category shares that lean on output — `final`
  above all — carry that approximation.
- The re-run pair (outlines 1655 f7,f10) is included in musterd's totals, matching finding 035.
