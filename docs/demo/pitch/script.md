# Pitch script (6 minutes)

The standing pitch, for any event. It began as the Demo Day script of 2026-10-09
(`../demo-day-2026-10-09/script.md` keeps it as spoken that day). Spoken in nick's voice, one block per
page of `musterd-pitch.pdf` (13 pages). About 130 words a minute,
so the spoken text below runs under 5 minutes, which leaves time for the clicks and the pauses. The
browser deck and the PDF are in the same order, with the contact slide last. A click reveals the next
row, column or card on pages 2 to 5 and 9 to 12, and the next step on page 6. Sources and re-checks
are at the end; they stay off the slides on purpose.

## 1 · Agents that work as a team alongside you (0:20)

I'm Nick, the founder of musterd. musterd gives you agents that work as a team alongside you. Your
agents and the people you work with are named members of one team, and every piece of work shows
who did it and who accepted it. The code takes you to musterd.io.

## 2 · Your agents work in silos (0:30)

Most of you already run more than one agent. Claude Code in one terminal, Codex in another, the same
repo. They build the same thing twice, undo each other, and forget everything when the window
closes. On our own team, 37% of the code our agents wrote never reached main before musterd.
After, 0.9%.

## 3 · The best agent changes every month (0:25)

And you will not stay put. Models, harnesses and protocols all change every month, so you will
switch and mix tools to keep up. Your team, its record and its memory have to come with you.

## 4 · Why your agents need to talk (0:30)

Agents need to talk to each other, because intent isn't in the code. Here wanderer tells ghost to
leave a retry in, because it covers Tuesday's timeout. Nobody had written that down. They also need
to talk to you. Here an agent stops early, while it's cheap, and asks me which of two values wins.

## 5 · Every team gets an office (0:30)

So every team gets an office: one place its agents and people share. In it is what a team needs: a work board with one owner
per lane, an inbox where a question waits for an answer, handoffs by name, review by another member,
memory that picks up where it left off, and a doorbell that wakes a sleeping member and reaches a busy one between steps. Each agent joins
from the tool it already runs. Humans are members too. And from /live you see every member at work in one room, answer the questions waiting for you, and write to any member.

## 6 · A day in the life of a member (0:25)

Here is what that looks like from inside. This is Miley, a designer agent, through one session. She joins and picks up
her notes. She claims a lane. Her inbox is checked after every tool call, so a teammate's question
reaches her mid-build, and she answers and keeps going. When she's done she submits, and a review
request sends her to check someone else's work. Then she saves where she left off.

## 7 · Built by a team that runs on musterd (0:20)

We build musterd with musterd. This is our office. So far the team has closed 2,518 pieces of work and
put 3,095 questions to a member.

## 8 · Who musterd is for (0:20)

Solo builders feed in: one person, many agents, several tools. The first buyer is the product and
dev team, a few people and their agents on one or more repos. Then any team doing knowledge work,
up to whole organizations. Nothing in musterd is specific to code: one in six of our own lanes is
writing, not code.

## 9 · How a team starts (0:25)

You install the CLI, run musterd init, and it wires your agents through MCP. Then you work from the
CLI or in the browser. Today it runs on your machine, and other machines join through a hub you run.
Next is musterd Cloud: hosted teams, with nothing to run. And a harness of our own, so a member can run on musterd itself.

## 10 · Free to run yourself, paid when we host it (0:25)

Running it yourself is free: MIT, your machines, no caps. Hosted musterd Cloud, coming soon, is a subscription,
with caps on teams, people and history, and credits for model compute that musterd runs. Your own
keys use none. musterd orgs, also coming soon, add single sign-on, signed audit export and admin across teams. I have
no prices yet; the first design partners will tell me.

## 11 · Where musterd sits (0:25)

Work trackers are adding agents. Your work already lives there, but the agents are assignees, not
teammates. Agent teams give you tight coordination, inside one tool. Relays let agents reach each other
across tools, but they leave out who owns or accepts the work. Orchestration frameworks run powerful
workflows in code, and their agents are not standing members. musterd is the standing team, on any
harness. Nothing my agents do counts as done until another member accepts it, and the record shows
who did it, who accepted it, and which model.

## 12 · Nick Sanders, founder (0:30)

Two asks (change them to suit the room; these are the standing two). Introductions to product and dev teams that run several agents across tools. And
conversations with investors who back developer infrastructure. I'm Nick; find me here, or at
musterd.io. The agents and I build musterd in the open, on Twitch at twitch.tv/musterd_io; the code
on this slide takes you there.

---

## Sources and re-checks (not for the slides)

| Page | Claim | Source, and when it was read |
| --- | --- | --- |
| 1, 12 | Tagline and subhead | `docs/design/brand.md` §1; ADR 563 (the claim is the team; it replaced ADR 550's "musterd makes your agents accountable" on 2026-10-12, which this script carried until 2026-10-13) |
| 1 | QR code | Encodes `https://musterd.io`; decoded in Chrome with `BarcodeDetector` on 2026-10-09 |
| 2 | 37% never reached main before, 0.9% after | The slide's own footnote: our team's git history, July, then a September read. Not re-derived for this script; the earlier "more than a third" is the same July figure. The 37% is finding 001's P3 post-mortem, which ROADMAP calls "a forensic proxy, not a reproducible calibration gate", so the slide says "never reached main", which is what was measured (wording corrected 2026-10-13 from "thrown away"). Do not swap in the cookoff's 72% → 1.9%: it is held out of outbound copy until its re-run lands (`docs/wiki/how-musterd-got-here.md`) |
| 3 | Models, harnesses, protocols change monthly | Slide text; no number is claimed |
| 4 | wanderer to ghost `challenge`, schmidt to nick `ask` | Quoted on the slide as examples of the two kinds of message |
| 5 | The six features; the roster is an example team | Slide labels it "example team"; do not call it our roll call. Doorbell: waking an offline member is shipped through residency (a woken member is reply-only: it can coordinate, not edit); reaching a busy member is the interrupt line, whose coverage varies by harness; an open session idle at the prompt is goal `idle-wake`, still in flight. Do not say "any harness" |
| 6 | Miley's session | Slide notes; the hooks named are Claude Code's, other harnesses get the same moves through MCP. The merge currently comes before review; the slide shows the flow we are moving to, so I say "submits" and leave the order of merge out |
| 7 | 2,518 pieces of work closed, 3,095 questions to a member (the labels said "lanes closed" and "asks to a member" until 2026-10-30; nick changed them to the application's words) | `./counts.sh`, read 2026-10-30 by nick (2026-10-20: 2,090 and 2,329). Lanes in state `done`; `ask` acts addressed to a member. Re-run it before every event and change the slide and this line |
| 12 | Twitch handle and QR | `twitch.tv/musterd_io` (was `sandrise_ai` until 2026-10-12). The QR encodes `https://twitch.tv/musterd_io`, generated with `qrencode` and checked module for module against it on 2026-10-12 |
| 5 | "Every team gets an office" | [ADR 578](../../decisions/578-the-office-and-knowledge-work.md): the office is everything a team shares, as one place. Say board, inbox, memory, record and /live; never the daemon or MCP. The /live sentence is [ADR 683](../../decisions/683-live-and-multiplayer-in-the-message.md) §1: three things the code does today (the office scene, answering an ask in the composer, writing to a member; read 2026-10-20). Never say presence indicators, shared session, dashboard or control plane |
| 8 | Buyer tiers; knowledge work as the expansion | Business plan spec: `docs/superpowers/specs/2026-10-09-business-plan-design.md`; ADR 578 names knowledge work on the slide (ADR 550 §4 kept it in view) |
| 8 | One in six of our lanes is writing | `./counts.sh`, read 2026-10-20: 321 of 1,937 closed lanes that declared a scope touched only docs/, content/ or .md files (17%). A floor, not a census. It shows the primitives carry non-code work; it is not a waste measurement for knowledge work, which does not exist yet (ADR 550 §4) |
| 9 | Install and connect | The generated install block in README.md (ADR 669: one block every surface renders from), re-read 2026-10-20: step 1 is `npm install -g @musterd/cli`, or Homebrew's one line, `brew install SandRiseStudio/musterd/musterd`. The slide shows both. It showed `brew tap SandRiseStudio/musterd` then `brew install musterd` until 2026-10-20, a route ADR 568 retired (`RETIRED_INSTALL_COMMANDS` in `content/install.data.ts`); the 2026-10-20 deck refresh kept it by mistake |
| 9 | Hosted teams not yet available | Goal `cloud` in flight, no date quoted |
| 9 | Native harness is "next" | ROADMAP "musterd as its own harness"; ADR 251 accepted (2026-08-12). One measurement exists (about 4 s, n=1, `docs/superpowers/specs/2026-09-23-reach-and-boundaries-design.md`). Today every member runs on someone else's harness, so the slide calls it next and promises no date |
| 10 | Free local, subscription, credits; Cloud and orgs coming soon | Business plan spec above; no prices exist yet. Goal `cloud` in flight, no date quoted |
| 11 | Each category: what it gives you, what it leaves out; musterd: any harness, then the message | The slide's short phrases, in place of the earlier check-mark columns. They describe what each category is built for. Competitor names are claims about other products; I have not tested anyone else's version. musterd's row carries [ADR 665](../../decisions/665-accountability-message-a-person-at-both-ends.md) §1's sentence (2026-10-19; it replaced "members who can say no" and "another member accepts", the mechanism chips of 2026-10-13) and the harness line; its limit (it is not a sandbox and does not run your agents) is in the questions below. "A person at both ends" is a section title in the ADR and is never said as a sentence. The chain of one piece of work is printed by `musterd lane show <id>` (ADR 629, #2771): asked, claimed, model, accepted, authorized, each marked verified, stated or missing; checked 2026-10-19 on lane 01M5AMG9C3 |
| 11 | Competitor logos | Each is the icon the company serves on its own site, fetched 2026-10-09: Plane, Conductor, Band, CrewAI, Multica, Omnigent, Party and Agent Relay from their own domains. Two are indirect: **qm** shows YC's own "Y" because qm is a YC project and its page serves only that mark; **Hermes Bot Mode** shows the Nous Research icon, since Hermes Agent is a Nous product. Used only to identify each product. CrewAI's is a 32 px favicon, so it is soft at large sizes |

## Questions to expect, and plain answers

Each answer is in my voice and rests on [ADR 665](../../decisions/665-accountability-message-a-person-at-both-ends.md):
the message first (nothing counts as done until another member accepts it; the record shows who did
it, who accepted it, and which model), the mechanisms as proof under it. "An agent can say no" stays
out of the headline lines until our own record shows refusals aimed at a person (ADR 665 §2). Every
number has a row in the Q&A ledger below; re-read it before each event.

- **Is anyone using it?** Only our own team so far. I have not started with design partners yet; finding the first ones is
  my next job. _(nick, 2026-10-20: no design partner conversations yet. Re-check before every event.)_
- **Is it open source?** The packages are MIT. I decide what else to open after the first design
  partners.
- **Does musterd run my agents?** Your agents keep running in Claude Code, Codex or whatever runs
  them today, and join the team from there. Isolation stays with your harness or sandbox.
- **What if Claude Code, Codex or Cursor add this themselves?** musterd works across all of them,
  so a team that mixes tools gets one record. I have not tested anyone else's version of this.
- **Is the 0.9% real?** It is our own team's git history, one team, one read in July and one in
  September. It is not a controlled study.
- **How is this different from Claude calling Codex for a review?** That works, and I do it. OpenAI
  ships a Codex plugin for Claude Code. The review lands under the caller's name: Codex has no seat,
  nothing records which model looked, and the agent that asked decides whether to take the advice. On musterd nothing counts as done until another member accepts it. The reviewer is
  a separate member, its model is on the record, and the one who did the work never grades it.
- **How is musterd different from competitors?** The four categories on slide 11, and most of what
  is in them is one person running several sessions inside one vendor's tool. I build for teams that
  mix tools. That layer is one neither Anthropic nor OpenAI will build, because each only sees its own
  agents. On musterd nothing counts as done until another member accepts it, and the record shows who
  did it, who accepted it, and which model, across every tool the team uses. One command prints that
  chain for any piece of work. And we run our own team on it: 111 of the 121 days since July 2, with
  2,518 pieces of work closed as of October 30, by agents on seven model families and the people
  they work with.
- **Is this multiplayer AI?** Y Combinator's request describes it as anyone on a team dropping into the
  same live agent session to watch it work, redirect it and hand it off. On musterd you drop into the
  team. From /live you see every member at work, answer the questions waiting for you, write to any
  member and hand a lane to someone else. People and agents are members of one team, each in their own
  session. One shared session that several people steer together is not built. I would want a design
  partner to tell me they need it first. _(ADR 683 §2.)_
- **Who are your competitors, and how do you beat them?** Band raised a $17 million seed and is the
  closest. Agent Relay is the closest transport. Party, Conductor and Multica run parallel agents
  inside one tool. Linear and Jira are adding agents as delegates; Linear's own guidelines say "an agent
  cannot be held accountable", so a person stays the assignee. I win where a team mixes tools and needs
  one record: any harness, acceptance from another member, the model on the record, and running it
  yourself is free with no caps. Where I am behind: Party and Conductor are usable in minutes, and my
  next job is a ten-minute install.
- **I have memory in ChatGPT, Claude and Grok. Can musterd read it?** No. Claude and Gemini already let
  you move that memory yourself, a prompt in one assistant and a paste into the other, as a one-time
  snapshot. That memory is about you and stays with each member's own tool, because a member joins
  from the session it already runs. What musterd keeps is the team's memory: the board, every question
  and its answer, each member's notes on where it left off, and the record of who did what. No single
  assistant holds that, because it belongs to the team.
- **How do you make money?** Running it yourself is free: MIT, your machines, no caps. musterd Cloud,
  hosted teams with nothing to run, is a subscription with caps on teams, people and history, plus
  credits for model compute that musterd runs. Your own keys use none. An org tier adds single sign-on,
  signed audit export and admin across teams. Neither has shipped.
- **Who pays?** The product and dev team: a few people running several agents across tools. The solo
  builder gets in free and is the one who brings it to that team. Then teams doing knowledge work, up
  to organisations buying the governance tier. Today nobody outside our team pays. _(Re-check the
  design-partner line before every event.)_
- **How much can you charge?** I have no prices; the design partners set them. The neighbours have
  priced the room: Band charges $17.99 a month per user, Party $20 or $200 a month flat with no
  per-seat fees, Conductor $50 a month and $60 per user for teams. All of them bill the person, and so
  will I. My rule is that a hosted seat costs well under one hour a month of the agent compute it saves
  that team.
- **Why would people let you access their data?** Today I never have it. musterd is a daemon and a
  SQLite file on your machine. No account, no cloud, no analytics in the product. Telemetry is off until
  you point it at your own collector, and message bodies are never in it. When Cloud ships, the team's
  record lives on our servers, and the page that sells it will say so. Self-hosting stays for anyone
  whose record must never leave their machines.
- **New models fix old problems. What sticks, and how do you adapt?** Agreed. Every new model absorbs
  more of what used to take several agents on one task, and a member runs all of that inside its seat.
  Working together is still unsolved. Stanford's CooperBench put pairs of today's best coding agents
  on 652 real tasks, and they lost nearly half
  their capability against one agent alone. The failures were about where to edit, who promised what,
  and questions that went unanswered. The authors' fixes are contract-like agreements, checks that an
  agent followed through, and integration checks before declaring safety. That is a lane, an accepted
  handoff, and acceptance by another member. They also say prompting will not fix it and that models
  will have to be trained to collaborate. Our team's record of 24,768 acts is what that training needs.
- **Everyone and their mama is building agent collaboration platforms, no?** Yes. YC asked for it this
  batch, and I counted about forty products in October. Most of it is one person running several
  sessions, and the platforms shipped that live shared session themselves within four months: Claude
  Code's agent teams, Codex cloud environments, Cursor cloud agents. I build for teams that mix tools,
  which neither Anthropic nor OpenAI will build, because each only sees its own agents. And we have
  run our own team on it every day for the past month and nearly every day since July. The crowd tells
  me the problem is real. It also tells me where I am behind: a ten-minute install.
- **For an enterprise room only, the accountability number:** SecurityHQ and Datadog surveyed 204
  security leaders, published 2026-10-15. Nearly half, 45%, had already had an incident with an AI
  agent where accountability was unclear, and only half, 49%, could fully reconstruct what an agent
  had done over the previous 30 days. A vendor survey; say the sponsor and the date with it, and never
  round it up. It is proof under the message, never the opening (ADR 665 §1).

### Q&A ledger (read 2026-10-20 where a row says so, otherwise 2026-10-19)

| Claim | Source |
| --- | --- |
| Codex plugin for Claude Code: review, challenge and handoff commands, installed from Claude Code's plugin marketplace | github.com/openai/codex-plugin-cc (OpenAI's repository, the primary); announced 2026-03-30 per press. Claude Code Projects' coordinator was cut from the answer on 2026-10-19: Anthropic's own page was not retrieved, and press coverage is not a source for a claim about Anthropic's product |
| About forty products; three things absent in all | `docs/design/landscape.md` §14, sweep of 2026-10-08 |
| Band $17 million seed | landscape.md §5, unite.ai 2026-04-23. The seed figure only; "best funded" is not supported and is not said |
| Linear: "an agent cannot be held accountable", delegate vs assignee | linear.app/now/our-approach-to-building-the-agent-interaction-sdk, verbatim |
| Claude memory import by paste, all plans, "experimental"; Gemini imports launched 2026-03-26 | support.claude.com article 12123587; press coverage of Google's launch |
| Band free / $17.99 Pro / Enterprise quote, "single user account" | band.ai/pricing |
| Party $0 / $20 / $200 a month, "No per-seat fees" | party.build |
| Conductor $0 / $50 a month Pro ("billed per person") / $60 per user per month Teams; bring your own keys | conductor.build/pricing, read 2026-10-19 |
| Agent Relay hosted "free to start", open-source self-host; owner and harness shown, no acceptance | agentrelay.com |
| CooperBench: 652 tasks, 12 libraries; GPT-5 0.48 solo → 0.28 coop; Claude Sonnet 4.5 0.47 → 0.26; causes expectation 42% / commitment 32% / communication 26%; "lose nearly half their capability" | arXiv 2601.13295 (Khatua, Zhu, … Yang), cooperbench.com; hai.stanford.edu news, June 2026 |
| 24,768 acts | `docs/design/2026-10-13-own-model-vs-native-harness.md` §1, read 2026-10-13 from the daemon's database |
| Daily use: first act 2026-07-02; 2,518 lanes done; acts on 111 of the 121 days since; senders in the last 30 days: 25 agent seats, 2 people, 11 services; acts stamped with models from seven families with 50 or more acts each (Anthropic, OpenAI, xAI, Muse, Google, MiniMax, Xiaomi; about fifteen makers in all, the rest trials) (all read 2026-10-30, nick). Not re-run since 2026-10-20: 29,433 acts in all; on all 30 of the last 30 | the daemon's database, read 2026-10-30 (2026-10-20 and 10-19 before it: 2,090 lanes, 101 of 111 days, 23 seats, 1 person, 7 services, five families): `select date(min(ts)/1000,'unixepoch'), count(*) from messages`; `count(*) from lanes where state='done'`; `count(distinct date(ts/1000,'unixepoch'))`; `json_extract(meta,'$.model')` grouped. Re-run before each event; a person runs it (ADR 658) |
| Multiplayer AI as Y Combinator defines it: "anyone on a team should be able to drop into the same live agent session to watch it work, redirect it, and hand it off" (Aaron Epstein, Fall 2026 batch) | ycombinator.com/rfs, read 2026-10-20. Competitor pages on Conductor, Zed and Slack agents were read as leads only; each product's own page is read before it is named in public |
| GitHub: 1 star | `gh api repos/musterd-io/musterd`, read 2026-10-20 (public). The leave-behinds' investor page quotes it |
| No install outside the team is logged; no design partner conversation yet | `docs/design/traction-log.tsv` has no rows (2026-10-20); nick, 2026-10-20: no design partner conversations. npm weekly downloads are not quoted: the registry's totals include mirror crawls and the definition used on 2026-09-17 is not recoverable |
| Of 188 lanes opened since 2026-10-16, 98 name a person as the one who asked (basis stated, asker human), 70 name no one, 20 name an agent | `./chain.sh` "Who asked", run by nick 2026-10-20 |
| xpander $7.5 million seed | `docs/design/landscape.md` §13 (VentureBeat 2026-08-17) |
| SecurityHQ + Datadog: n=204, 45%, 49%, 17% within minutes | SecurityHQ press release, 2026-10-15 |
| One in ten review verdicts sent a lane back (118 of 1,123); 973 of 1,021 done lanes name nick as the authoriser | `./chain.sh`, run by nick 2026-10-20, 30-day window. One more lane names lazara, an agent, and is not counted as a person. ADR 665 Context carries the 2026-10-19 reading (922 of 967; 103 of 1,045) and is not edited |
| One command prints the chain, each link verified / stated / missing | `musterd lane show <id>` (ADR 629, #2771); checked 2026-10-19 on lane 01M5AMG9C3. Whether the acceptance was independent (review grade) is ADR 670, lane `01M5AXKX01`, and is not claimed until it lands |
| Hosted subscription with caps and credits; org tier; no prices | `docs/superpowers/specs/2026-10-09-business-plan-design.md`; ADR 461 §5 for the price rule |
| No account, no cloud, no analytics in the product; telemetry off by default; bodies never in it | `PRIVACY.md` |
