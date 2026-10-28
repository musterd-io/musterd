# Single-agent loop guidance

What Anthropic's October 2026 advice to fold subagents into one agent loop says, how strong its evidence is, and what it does and does not mean for musterd.

Read 2026-10-27 by dolly, at nick's request (lane `01M5ZWJFC9MF338F6HM6ET83BV`).

## The sources

- **The original:** "Building agents: When to fold subagents into your main agent loop", Diane
  Sarkis, claude.com, dated 2026-10-22
  (<https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop>).
  It points to a migration kit, `anthropics/single-agent-loop-kit` on GitHub.
- **The write-up:** Matthias Bastian, *The Decoder*, 2026-10-25
  (<https://the-decoder.com/anthropic-says-one-ai-agent-beats-many-subagents-now-that-models-can-handle-complexity-alone/>).
  It adds outside context: a Vals study and a remark by an OpenAI developer.

## What the original claims

The recommendation: for many enterprise agents, one agent loop that loads skills and tools on
demand ("progressive disclosure") beats a set of specialist subagents. It is better on quality,
and it costs less and runs faster. Migrate in stages, and measure each stage against an end-to-end
eval set.

Subagents still earn their place in three cases, quoted from the original:

1. "A single agent loop hits measurable performance degradation from context bloat."
2. Parallel work needs "fresh context windows that can be discarded once the task is done."
3. "A single agent struggles to select appropriate tools or there are conflicting instructions in
   the system prompt."

A full handoff to a subagent is warranted only "when it needs to talk to the user directly."

Other points:

- "once you exceed 30-50 tool definitions in the system prompt, tool choice tends to degrade."
  The fix is to group tools by user intent and load them through tool search.
- The default shape: "One clear system prompt, 4-5 thin data tools, and firm output guardrails."
- Claude Code's system prompt for its newer models was cut "by over 80%", partly by loading
  skills and tools only when needed.

## How strong the evidence is

| Claim | Evidence given |
| --- | --- |
| One loop runs about 2× faster | One customer's comparison. No setup, workload or method is given. |
| One loop with skills beats both a single big prompt and subagents on quality | "Several enterprise comparisons", with no figures. |
| Tool choice degrades past 30–50 tools | Stated as experience; no measurement is cited. |
| Folding can break a working process | A sample support agent. Folding cut latency, but in one of two runs the main agent answered by itself instead of consulting the specialist. |

All of the evidence comes from Anthropic, which sells the models whose single-loop ability is the
premise. The one outside data point is in *The Decoder*: a Vals study found agent teams can be
faster than one agent but no better on quality. Going from 10 agents to 30 or 100 added cost and
no quality.

*The Decoder* describes a coding example: context is lost between writing the feature, writing the
tests and reviewing, so one agent writes the feature and its tests and a verifier only runs them.
The original, as read on 2026-10-27, does not contain that example. Cite it to *The Decoder*,
never to Anthropic.

## What it means for musterd

**It backs the seat rule.** The article argues against handing one task between anonymous
workers. It favours one capable loop that owns the whole unit of work. That is the AGENTS.md rule:
subagents may read, but seats must write, with a lane per unit of work. A read-only fan-out is the
article's exception 2 (fresh, discardable context), which the rule already allows.

**It backs ADR 741 (hot tools).** The 30–50 threshold and loading tools through tool search are
the design of [ADR 741](../decisions/741-mcp-hot-tools-lane-lifecycle.md). musterd's MCP server
registers 31 tools (`TOOL_NAMES` in `packages/mcp/src/toolNames.ts`, counted at `d47972579`).
These come on top of the harness's own tools and any other MCP servers, so a seat's total can pass
the threshold before musterd's tools load.

- A musterd seat on Claude Code can see more than 50 tool definitions at once if every MCP tool loads up front (2026-10-27; falsify: count the tool definitions in one seat's first request with `docs/research/hot-tools/toolsearch.py`'s capture, and find 50 or fewer) <!-- claim: other -->

**It challenges how musterd splits work.** "Information loss at every handoff" applies to
musterd's own handoffs between seats, and to splitting one change across several lanes. A worked
case, 2026-10-27: OpenRouter lane 3/4 (`01M5JE08RMK8QAQ4BVW9DAYHWS`, PR #3397) changed how the
gateway prices and forwards requests. It left the matching ADR 714, ADR 583 and `04-cli.md` updates
to lane 4/4, which had docs in its scope. The acceptance verdict declined it, because docs and code
must agree at every commit. The split put the docs in a different lane from the change they
describe. When the same seat would do every step, the guidance points to fewer, fuller lanes, with
a handoff only when the owner really changes.

- Splitting one change into several lanes by the same owner leaves its docs behind more often than a single lane does (2026-10-27, from one case; falsify: over the next 20 multi-lane goals with one owner, count the declines for docs and code disagreeing, and find no more than the rate for single-lane work) <!-- claim: other -->

**It does not answer the case for a team.** The article is about subagents inside one agent's
task, not about long-lived seats with their own identities and models, working alongside humans.
None of its three exceptions covers model diversity or independent review. The Vals result (more
agents, same quality) does bear on the model-diversity thesis of
[ADR 314](../decisions/314-correlated-models-correlated-mistakes.md). That thesis should be
measured against it, not assumed. musterd's acceptance step routes the verdict to a seat on a
different model family (`route: cross_family`), and that routing is the place to measure it.

- musterd has no measurement that a cross-family acceptance catches more than a same-family one. Finding 004 shows that the diversity flag renders correctly, but it does not show that diversity catches more defects (2026-10-27; falsify: find an eval in `docs/research/` that compares decline rates or missed defects by acceptor family) <!-- claim: other -->

## Related

- [Context budgets](context-budgets.md)
- [Local model context floor](local-model-context-floor.md): the same tool-loading cost, on a small context.
