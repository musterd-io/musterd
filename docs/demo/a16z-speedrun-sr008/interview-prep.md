# SR008 interview prep — one page for the 10-minute call

> For nick, if speedrun invites the application of 2026-10-30 ([the record](README.md)) to an interview.
> Written 2026-10-30 from the pitch's Q&A bank ([`../pitch/script.md`](../pitch/script.md), "Questions to
> expect") and the competitor table in [`landscape.md`](../../design/landscape.md) §14d. Every number has a
> row in one of those ledgers or in the record's sources; re-read them the day of the call, because a
> partner may have read the application weeks earlier. speedrun's own advice (2026-10-07): "Catch me in the
> first two" minutes, and "If I bring up a competitor, you should know about it."

## The first two minutes: your story, then the product

1. Analyst at Fannie Mae who taught himself to program, shadowed the engineers and did work outside his
   role until he became an engineer, then led the developer-tools team for 220+ applications. The win:
   package approval from two weeks to an instant download, by building the approval into the download.
2. MBA, then PM at VMware: a $300M ARR launch.
3. All in on AI since 2024; running Claude Code, Codex and Cursor on one repo brought the Fannie Mae problem
   back. Agents built the same thing twice, overwrote each other, and nobody could say which model did what.
4. musterd puts agents and people on one team. Nothing counts as done until a different member accepts it,
   and the record shows who did it, who accepted it, and which model.
5. Built on musterd itself since June: about two dozen agents, 2,518 pieces of work closed.

## Numbers to know cold (all read 2026-10-30 unless marked)

| Number | Say it as |
| --- | --- |
| 2,518 | pieces of work closed by the team, with activity on 111 of the last 121 days |
| 37% → 0.9% | share of our agents' code that never reached main: before the board and review existed, then in September. One team, two reads, not a controlled study |
| 0 of 10 vs 6 and 7 of 10 | CooperBench pairs with conflicting patches: musterd's agents vs CooperBench's own two-agent setups (pre-registered, October). Never quote a pass rate |
| about two dozen; seven | agents on the team; model makers with 50+ acts in the last 30 days |
| 180 of 1,454 | review verdicts in 30 days that sent the work back, each from a member other than the author |

## Competitors, in one breath each

- **Band** ($17M seed, the closest): identity in shared rooms; no decline, no acceptance by another member,
  no record of which model.
- **Agent Relay**: the closest transport (handles and channels); shows owner and harness, no acceptance.
- **Party, Conductor, Multica**: parallel agents inside one tool, usable in minutes. Ahead of us on onboarding.
- **Claude Code agent teams, Codex cloud, Cursor cloud agents**: the platforms' own versions, each inside
  one vendor's walls.
- **Linear, Jira**: agents as delegates; Linear's guidelines say "an agent cannot be held accountable".

**The line:** across about forty products, three things are absent everywhere: an agent that can decline
or challenge, acceptance that must come from a different member, and a record of which model did the work.
That is musterd, across any tool a team mixes. **Where I'm behind:** a ten-minute install, and adoption.

## Why now

Teams already run several agents across tools, and each platform only sees its own agents, so neither
Anthropic nor OpenAI will build the layer between them. Stanford's CooperBench found pairs of today's best
coding agents lose nearly half their capability against one agent alone, failing on who promised what and
unanswered questions. For an enterprise room only: SecurityHQ and Datadog (n=204, 2026-10-15) found 45% had
had an agent incident with unclear accountability; say the sponsor and the date with it.

## Hard questions, short answers

- **Anyone using it?** Only our own team. I've demoed it at two SF events; the second's hosts, the incubator
  EPIC Connector, followed up and introduced me to their venture partner. The first design partners are my
  next job; the residency is how I get them onto hosted musterd.
- **What if Anthropic or OpenAI build it?** They'll build it inside their own walls. A team that mixes tools
  needs one record across them.
- **How do you make money?** Self-hosted stays free and MIT. The hosted team is the subscription, with caps
  and compute credits; an org tier adds SSO and signed audit export. No prices yet; design partners set them.
- **Where is the sandbox?** musterd doesn't run agents. They keep running in the tool they already use;
  isolation stays with that tool or sandbox.
- **You're solo.** Full time, building with a team of agents every day, and open to a technical co-founder.
- **Twelve weeks from now?** Hosted musterd live, the first outside teams on it for two weeks or more, and
  the first paying team.

## Don't say

"Proves" or "guarantees" (say "the record shows"); "a person at both ends" or "who asked" (87% of lanes name
the asker, under the 90% bar); the CooperBench pass rate; the cookoff multiplier; the GitHub star count.
