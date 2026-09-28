# 012 — The trace store rebuilds a lane's coordination-token ratio within 1%, and cannot see its wasted work

**Date:** 2026-09-28 · **Seat:** ryder (claude-opus-5-5) · **Lane:** 01M3MG7BXY853JC4593APH3692 · **Status:** finding

**Question.** ADR 445's §Observability experiment: run one seat through a real lane with all three
rails on, rebuild finding 001's two hand-computed numbers — the **coordination-token ratio** and the
**wasted-work ratio** — from `trace_events` alone, and check them against a hand read of the
transcript. The pass bar is agreement within 5%.

**Setup.** The lane is ADR 445 increment 4b (`01M3FEB12R870FRSYJH0TXD34V`, PR #1757, `c5edd14a`),
built by ryder on Claude Code with `trace.content: on`. Its claim window runs from 2026-09-26
18:53:01Z to 20:31:11Z. All of it is one session, transcript `4ca5956d…`, digest `d2590ee9d98b`,
confirmed by `musterd trace show`. The two sides:

- **Trace:** `~/.musterd/trace.db` rows for that digest inside the window. Fresh tokens are the sum
  of `input + cache_creation + output` over the R2 `usage` rows. Coordination bytes are the sum of
  `tool_input_bytes + tool_response_bytes` over R1 `PostToolUse` rows whose tool is
  `mcp__musterd__*`. This uses structural columns only.
- **Hand read:** the same window in the Claude Code jsonl. Usage is deduplicated by `message.id`.
  Coordination bytes are the compact-JSON tool input plus the `tool_result` text of each
  `mcp__musterd__*` call.

Coordination tokens are bytes ÷ 4, the same chars÷4 proxy finding 001 used. `musterd` calls made
through Bash are excluded on both sides.

**Result — coordination-token ratio: pass.**

|                               | trace        | transcript   | apart |
| ----------------------------- | ------------ | ------------ | ----- |
| fresh tokens                  | 844,816      | 847,858      | 0.36% |
| musterd tool calls            | 10           | 10           | —     |
| coordination bytes            | 14,182       | 14,104       | 0.55% |
| **coordination-token ratio**  | **0.4197%**  | **0.4159%**  | 0.9%  |

Per call, 7 of 10 byte counts match exactly. Two `team_inbox_check` responses read 345 against 316,
and one `team_memory_save` reads 1,514/211 against 1,523/182. That is the hook payload's
serialisation of the tool response against the transcript's rendered text, a difference of tens of
bytes. R2 has 31 `usage` rows against 32 transcript messages; one message is missing, which is why
cache reads differ by 3%, but it barely moves fresh tokens.

The first run of the comparison read 0.42% against 0.33%, which fails the bar. That gap was an
artefact of the comparison script, not of the trace: the `lane_claim` call was issued about a second
before the lane's `claimed_at`, so a transcript read windowed on the tool *result* dropped its input.
The trace's `PostToolUse` row carries both halves, so it had no edge problem. Anyone repeating this
check should give the transcript side a lookback for tool calls near the window edge.

The number itself agrees with finding 001: coordination is well under 1% of fresh tokens.

**Result — wasted-work ratio: not reconstructible from `trace_events`.** Finding 001 measured waste
from git, as code produced that never reached `main`. The trace-side stand-in is the lines written by
`Edit` and `Write` calls. On 4b it sees only two of the fourteen files the PR landed:
`TraceTimeline.tsx` and its render test. Both rails agree exactly on those two, at 202 lines written
against 210 landed. Everything else was written through **Bash**: in the build window
(18:53–19:04Z) there are **13 file-writing Bash calls** (Python heredoc replaces, `cat >>`,
`sed -i`, plus `prettier --write` and `eslint --fix`) against 2 `Write` calls and 0 `Edit` calls.
Content capture records those commands, but a line count cannot be derived from a
Python string-replace script without re-executing it against the file as it stood. This is the same
agent-shaped blind spot that finding 008 measured for the subagent-write detector, met again from
the trace side.

**Also surfaced — lane attribution by claim window over-counts.** The 4b window includes the 4a
closeout (its `lane_submit`, `lane_resolve` and the decline thread with big-body), because 4a
resolved at the same moment 4b did. It also includes about 85 minutes after 4b merged at 19:08Z and
before it resolved at 20:31Z. `musterd report trace` uses the same rule (a `usage` row goes to its
seat's most recently claimed open lane), so its cost-per-lane figure for 4b carries both. Nothing
here is wrong by that rule's definition, but it is not the build cost of the lane.

**Honest-N caveat.** This is one lane, one seat and one harness (Claude Code), which is the harness
with the best-tested rails. The 5% bar was met by a single sample. The trace's coverage on this seat
over the same days was 99% (`musterd report trace`, 2026-09-28), so a pass is expected here. Codex,
Grok, cursor-agent and opencode are unmeasured (lanes 01M3MG7Q65, 01M3MGQ6M1, 01M3MGQ93W).

**What it changes.**

- The coordination-token ratio is now **emitted, not archaeology**, for Claude Code seats, which
  closes the first half of finding 001's "should be emitted" ask. It is computable from structural
  columns alone, so it survives `trace.content: off` and the public dataset export.
- ADR 445's experiment, as written, cannot pass on its wasted-work half. That is not a capture bug.
  Waste is a property of what reached `main`, and agents write files through channels the tool
  column does not type. Reconstructing it needs a git-side join, such as branch commits and the
  squash diff per lane, as `lanes-and-the-multi-agent-tax.md` §3.4 did. That join belongs to the
  lane record rather than to `trace_events`. Recorded on ADR 445 for nick to decide.
- Claim-window attribution needs a merge-bounded variant (claim to `merged` SHA time) before
  cost-per-lane is quoted as a lane's build cost.

**Reproduce.** The comparison is the method above. The script used is not committed, because the
transcript side reads a machine-local Claude Code jsonl.
