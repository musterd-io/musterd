# Demo Day script, 2026-10-09 (6 minutes)

Spoken in nick's voice, one block per page of `BP_musterd.pdf` (15 pages). About 130 words a minute,
so the spoken text below runs about 5 minutes, which leaves a minute for the clicks and the pauses. The PDF puts the contact page last. In the browser
deck the contact slide sits after the live demo (slide 10), and pages 10 to 14 here are slides 11
to 15 there. A click reveals the next row, column or card on pages 2 to 7 and 11 to 14. Sources and
re-checks are at the end; they stay off the slides on purpose.

## 1 · Agents that answer for their work (0:15)

I'm Nick, the founder of musterd. musterd makes your agents accountable: every member of a team,
agent or person, answers for its work. The code takes you to musterd.io.

## 2 · Your agents work in silos (0:30)

Most of you already run more than one agent. Claude Code in one terminal, Codex in another, the same
repo. They build the same thing twice, undo each other, and forget everything when the window
closes. On our own team, 37% of the code our agents wrote was thrown away before musterd. After,
0.9%.

## 3 · The best agent changes every month (0:25)

And you will not stay put. Models, harnesses and protocols all change every month, so you will
switch and mix tools to keep up. Your team, its record and its memory have to come with you.

## 4 · Why your agents need to talk (0:30)

Agents need to talk to each other, because intent isn't in the code. Here wanderer tells ghost to
leave a retry in, because it covers Tuesday's timeout. Nobody had written that down. They also need
to talk to you. Here an agent stops early, while it's cheap, and asks me which of two values wins.

## 5 · Everything a team needs (0:30)

So musterd gives a team what a team needs, for agents and for people: a work board with one owner
per lane, an inbox where a question waits for an answer, handoffs by name, review by another member,
memory that picks up where it left off, and a doorbell that wakes a sleeping member and reaches a busy one between steps. Each agent joins
from the tool it already runs. Humans are members too.

## 6 · Every piece of work carries its chain (0:35)

Here is one real piece of work: ADR 554, pull request 2242. dolly, a Claude agent, claimed it, so
nobody else built it, and submitted it. big-body, a different agent on a different model family,
judged the outcome and accepted it. Then I signed off as the human admin. Who claimed it, which
model did it, who accepted it: the record keeps every name.

## 7 · Members can oppose, and nobody grades their own work (0:20)

Any member can decline: "I won't take this, and here's why." Any member can challenge: "I think this
is wrong. Show me." And only a different member can close the work.

## 8 · Built by a team that runs on musterd (0:20)

We build musterd with musterd. This is our office. So far the team has closed 1,569 lanes and sent
1,484 asks to a member.

## 9 · Watch it live (0:15)

Right now you can watch the team build musterd on Twitch, at twitch.tv/sandrise_ai. The code takes
you there.

## 10 · A day in the life of a member (0:25)

One more look inside. This is Miley, a designer agent, through one session. She joins and picks up
her notes. She claims a lane. Her inbox is checked after every tool call, so a teammate's question
reaches her mid-build, and she answers and keeps going. When she's done she submits, and a review
request sends her to check someone else's work. Then she saves where she left off.

## 11 · Who musterd is for (0:20)

Solo builders feed in: one person, many agents, several tools. The first buyer is the product and
dev team, a few people and their agents on one or more repos. Organizations are the expansion.

## 12 · How a team starts (0:25)

You install the CLI, run musterd init, and it wires your agents through MCP. Then you work from the
CLI or in the browser. Today it runs on your machine, and other machines join through a hub you run.
Next is musterd Cloud: hosted teams, with nothing to run.

## 13 · Free to run yourself, paid when we host it (0:25)

Running it yourself is free: MIT, your machines, no caps. Hosted musterd Cloud is a subscription,
with caps on teams, people and history, and credits for model compute that musterd runs. Your own
keys use none. Organizations add single sign-on, signed audit export and admin across teams. I have
no prices yet; the first design partners will tell me.

## 14 · Where musterd sits (0:25)

Work trackers are adding agents. Your work already lives there, but the agents are assignees, not
teammates. Agent teams give you tight coordination, inside one tool. Relays let agents reach each other
across tools, but they leave out who owns or accepts the work. Orchestration frameworks run powerful
workflows in code, and their agents are not standing members. musterd is the standing team: any
harness, members who can say no, and another member who accepts the work.

## 15 · Nick Sanders, founder (0:20)

Two asks. Introductions to product and dev teams that run several agents across tools. And
conversations with investors who back developer infrastructure. I'm Nick; find me here, or at
musterd.io.

---

## Sources and re-checks (not for the slides)

| Page | Claim | Source, and when it was read |
| --- | --- | --- |
| 1, 15 | Tagline | `docs/design/brand.md` §1; ADR 550 |
| 1, 15 | QR code | Encodes `https://musterd.io`; decoded in Chrome with `BarcodeDetector` on 2026-10-09 |
| 2 | 37% thrown away before, 0.9% after | The slide's own footnote: our team's git history, July, then a September read. Not re-derived for this script; the earlier "more than a third" is the same July figure |
| 3 | Models, harnesses, protocols change monthly | Slide text; no number is claimed |
| 4 | wanderer to ghost `challenge`, schmidt to nick `ask` | Quoted on the slide as examples of the two kinds of message |
| 5 | The six features; the roster is an example team | Slide labels it "example team"; do not call it our roll call. Doorbell: waking an offline member is shipped through residency (a woken member is reply-only: it can coordinate, not edit); reaching a busy member is the interrupt line, whose coverage varies by harness; an open session idle at the prompt is goal `idle-wake`, still in flight. Do not say "any harness" |
| 6 | ADR 554, PR #2242, dolly (claude-sonnet-5-5), big-body (gpt-6-luna), nick as human admin | The slide's four cards. The accept text is big-body's. "Who asked" stays off: ADR 550 §3 says the record holds it only partly until lane `01M4EDCQ2W` lands |
| 7 | Decline, challenge, acceptance by a different member | ADR 103; ADR 188, 192, 234, 235 |
| 8 | 1,569 lanes closed, 1,484 asks | Figures printed on the slide; I could not trace them in the repo. Re-read the morning of and change the slide and this line if they moved |
| 9 | Twitch handle and QR | Slide; QR encodes `twitch.tv/sandrise_ai` |
| 10 | Miley's session | Slide notes; the hooks named are Claude Code's, other harnesses get the same moves through MCP. The merge currently comes before review; the slide shows the flow we are moving to, so I say "submits" and leave the order of merge out |
| 11 | Buyer tiers | Business plan spec: `docs/superpowers/specs/2026-10-09-business-plan-design.md` |
| 12 | Install and connect | README quickstart. **The slide says `brew install musterd`; the README gives `brew tap SandRiseStudio/musterd && brew install musterd`.** Fix the slide or say "from our tap" |
| 12 | Hosted teams not yet available | Goal `cloud` in flight, no date quoted |
| 13 | Free local, subscription, credits | Business plan spec above; no prices exist yet |
| 14 | Each category: what it gives you, what it leaves out; musterd: three strengths | The slide's short phrases, in place of the earlier check-mark columns. They describe what each category is built for. Competitor names are claims about other products; I have not tested anyone else's version. musterd's row lists strengths only; its limit (it is not a sandbox and does not run your agents) is in the questions below |
| 14 | Competitor logos | Each is the icon the company serves on its own site, fetched 2026-10-09: Plane, Conductor, Band, CrewAI, Multica, Omnigent, Party and Agent Relay from their own domains. Two are indirect: **qm** shows YC's own "Y" because qm is a YC project and its page serves only that mark; **Hermes Bot Mode** shows the Nous Research icon, since Hermes Agent is a Nous product. Used only to identify each product. CrewAI's is a 32 px favicon, so it is soft at large sizes |

## Questions to expect, and plain answers

- **Is anyone using it?** Only our own team so far. The first design partners start this month.
- **Is it open source?** The packages are MIT. I decide what else to open after the first design
  partners.
- **Who pays, and how much?** Hosted teams by subscription, with credits for model compute that
  musterd runs. I have no prices yet; design partners tell me what they would pay.
- **Does musterd run my agents?** Your agents keep running in Claude Code, Codex or whatever runs
  them today, and join the team from there. Isolation stays with your harness or sandbox.
- **What if Claude Code, Codex or Cursor add this themselves?** musterd works across all of them,
  so a team that mixes tools gets one record. I have not tested anyone else's version of this.
- **Is the 0.9% real?** It is our own team's git history, one team, one read in July and one in
  September. It is not a controlled study.
