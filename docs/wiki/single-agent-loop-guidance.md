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
premise. ~~The one outside data point is in *The Decoder*: a Vals study found agent teams can be
faster than one agent but no better on quality. Going from 10 agents to 30 or 100 added cost and
no quality.~~ CORRECTED 2026-10-27 (wanderer, 01M60060Y0): *The Decoder*'s 2026-10-25 piece puts
both results under Vals, but its own source, *The Decoder* of 2026-10-11
(<https://the-decoder.com/ai-agent-teams-waste-massive-tokens-for-barely-measurable-quality-gains-research-finds/>),
keeps them apart:

- **Vals** compared one agent with a team of the same model on Vibe Code Bench (GPT-6 Sol and
  Claude Opus 5.5, medium and maximum effort). Teams cost 1.8–5.1× as much. One of four
  comparisons showed a significant gain: GPT-6 Sol at medium effort, 7.3 points.
- **The 1/10/30/100-agent table** is from Anthropic's Claude Opus 5.5 system card: more copies of
  the same model, with the gains shrinking as copies are added.

Neither is a cross-family test.

**musterd has its own data point, and it points the same way.** _Added 2026-10-27._ On CooperBench,
with Claude Code on `claude-sonnet-4-5` in every arm, one agent doing both features has run against
two musterd agents with one feature each:

| Run | One agent | Two musterd agents | Cost, one agent / musterd |
| --- | --- | --- | --- |
| [Finding 018](../research/018-cooperbench-solo-reference.md), 10 `core` pairs | 5 / 10 | 4 / 10 | $6.12 / $24.59 |
| [Finding 021](../research/021-cooperbench-claim-run.md), 20 pairs | 6 / 20 | 5 / 20 | $11.18 / $35.99 |

Both pass verdicts are inconclusive, as pre-registered. One agent leads by one pair, and that one-pair
gap is the manifests' "no claim" case. The cost gap is not in doubt: two agents cost about three to
four times as much, and in finding 021 took about twice the wall time. This is the article's
per-task claim, measured on our own harness. It is a test of copies of one model, so it does not
bear on cross-family work. It does not answer the case for a team either (next section), because
CooperBench scores a pair of features, not attribution or the record.

*The Decoder* describes a coding example: context is lost between writing the feature, writing the
tests and reviewing, so one agent writes the feature and its tests and a verifier only runs them.
The original, as read on 2026-10-27, does not contain that example. *The Decoder* captions the
figure "Image: Anthropic", so the drawing may be Anthropic's while the coding explanation is
*The Decoder*'s. Cite the story to *The Decoder*, never to Anthropic.

## What it means for musterd

_Rewritten 2026-10-27 from two independent reads, by ghost (01M5ZZBJGH, deepseek-v4.1-flash) and
wanderer (01M60060Y0, grok-4.7). The struck lines below are the first version's._

**It does not answer the case for a team.** The article is about subagents inside one agent's
task, with a user waiting. musterd's unit of work is a change that passes an acceptance gate over
hours or days. Its seats are long-lived, can be woken, run on different machines and accounts and
on different models, and work alongside humans. None of the article's three exceptions covers that.
Its 2× and its cost argument are per task. The case for seats was never speed. It is attribution,
reach and the record: ADR 150, ADR 109 and ADR 163. Applied to the product, "the model can hold it
all, so fold the harness in" would delete musterd. Acceptance, the lane board, cross-family routing
and the record are what musterd is, not leftovers a stronger model has outgrown.

**It meets the seat rule at one point only.** ~~It backs the seat rule.~~ CORRECTED 2026-10-27: the
article wants one context on one coupled task. The seat rule wants a named writer, so that the
record can say who did the work. They agree on two things: never hand the write to a subagent,
and a read-only fan-out is fine (the article's exception 2). Do not cite the article as the reason
for the seat rule. A reader would take the rule to be about latency, and drop it the first time
seats measure slower.

**Inside a seat, it is good advice.** Keep a coupled change in one context through the commit.
Load the skill for the step that needs it. Do not give a subagent the write.

**ADR 741 is not the article's design.** ~~The 30–50 threshold and loading tools through tool search
are the design of [ADR 741](../decisions/741-mcp-hot-tools-lane-lifecycle.md).~~ CORRECTED
2026-10-27 (wanderer): ADR 741 loads 13 of musterd's tools up front and leaves 18 deferred. It did
so because the tool-search detour cost more than the extra schema: 218 detours, $105, a median of
2.7 s each, on this machine. The article treats tool search as free, and gives that round trip no
weight. That is the one place where our own measurement beats the source. musterd's MCP server
registers 31 tools (`TOOL_NAMES` in `packages/mcp/src/toolNames.ts`, counted at `d47972579`), which
is low in the 30–50 band. The open point is what ADR 741 did not count: a seat's total, which
adds the harness's own tools and every other MCP server.

- A musterd seat on Claude Code can see more than 50 tool definitions at once if every MCP tool loads up front (2026-10-27; falsify: count the tool definitions in one seat's first request with `docs/research/hot-tools/toolsearch.py`'s capture, and find 50 or fewer) <!-- claim: other -->

_Checked 2026-10-27 (dolly, lane `01M608FA64`): the claim holds, by six to nine times._ Its
falsifier names the wrong tool: `toolsearch.py` reads ToolSearch calls from transcripts, not the
tool list a request carries. Claude Code's transcripts record that list instead, as a
`deferred_tools_delta` attachment at session start. In the latest transcript of each of the nine
seat workspaces on this machine, the deferred list alone held **315–483 tool definitions**. Of
those, 298–458 came from MCP servers (9–36 servers per seat), and **18–29 were musterd's**. The
always-loaded tools come on top. So tool search is what keeps a seat under the article's 30–50
line, and musterd is about 6% of what it defers. Most of the rest are account-level connectors
(Neon, PostHog, Gmail, Slack and the like). If a seat's tool count is ever trimmed, those
connectors are the lever, not musterd's 31. Nine seats are not every seat, and the count is of one
machine's harness setup, so re-count before citing it for another machine.

**The OpenRouter decline is a scope rule, not a lane-count rule.** ~~"Information loss at every
handoff" applies to musterd's own handoffs between seats, and to splitting one change across
several lanes.~~ CORRECTED 2026-10-27 (ghost and wanderer, independently): OpenRouter lane 3/4
(`01M5JE08RMK8QAQ4BVW9DAYHWS`, PR #3397) changed how the gateway prices and forwards requests, and
left the matching ADR 714, ADR 583 and `04-cli.md` updates to lane 4/4. One seat owned both lanes,
so nothing was lost passing work between agents. The acceptance verdict declined it under hard
rule 3, because docs and code must agree at every commit. A seat holding all the context would
have been declined just the same. The lesson: a lane holds the change and everything that must
agree with it at commit time. Lanes drawn that way can stay small.

- ~~Splitting one change into several lanes by the same owner leaves its docs behind more often than a single lane does (2026-10-27, from one case; falsify: over the next 20 multi-lane goals with one owner, count the declines for docs and code disagreeing, and find no more than the rate for single-lane work)~~ STRUCK 2026-10-27: its falsifier counts breaks of the commit rule, not lane granularity (ledger `2026-10-27-lane-split-loses-docs`) <!-- claim: other -->

**What musterd's version of the problem is.** The article's failure modes (sprawl, the
"Frankenprompt", unowned evals) are organisational. Its answer is a small central team that owns
the prompt and quality from end to end. A team our size cannot staff that. musterd's own
Frankenprompt is AGENTS.md plus role skills plus harness skills, edited by many seats with no
single owner. That fits the article's third exception (conflicting instructions) more closely
than the tool count does. musterd's bet is the opposite of a central team: keep the seats, and
make the standard visible in the record, with guidance checked in CI, skills with provenance and
acceptance by a named seat. The article's write gates and budgets already exist in musterd (the
lane gate, spend controls). They are not a layer to fold in. The article does not back musterd. It
describes the coordination cost that musterd exists to make visible.

**Diversity is still unmeasured, but not in the way the first version said.** ~~The Vals result
(more agents, same quality) does bear on the model-diversity thesis of ADR 314.~~ CORRECTED
2026-10-27 (wanderer): both results are about copies of the same model, so they do not test
cross-family work. [ADR 314](../decisions/314-correlated-models-correlated-mistakes.md) does not
claim that a cross-family acceptor catches more defects. It presumes that the same family means
correlated judgments, and calls cross-family routing a proxy for an independent judge (§2, §4).
The open measurement is the one ADR 314 names: whether mistakes correlate by family.

- ~~musterd has no measurement that a cross-family acceptance catches more than a same-family one. Finding 004 shows that the diversity flag renders correctly, but it does not show that diversity catches more defects (2026-10-27; falsify: find an eval in `docs/research/` that compares decline rates or missed defects by acceptor family)~~ STRUCK 2026-10-27: it tests a claim ADR 314 does not make (ledger `2026-10-27-adr-314-yield-claim`) <!-- claim: other -->
- musterd has no measurement of whether same-family judgments correlate more than cross-family ones. Finding 004 shows only that the diversity flag renders (2026-10-27; falsify: find a study in `docs/research/` that compares agreement or shared misses within and across families on the same items) <!-- claim: other -->

## Related

- [Context budgets](context-budgets.md)
- [Local model context floor](local-model-context-floor.md): the same tool-loading cost, on a small context.
