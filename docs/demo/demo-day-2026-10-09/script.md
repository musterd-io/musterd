# Demo Day script, 2026-10-09 (6 minutes)

Spoken in nick's voice, one block per slide in `BP_musterd.pdf`. About 130 words a minute, so the
spoken text below runs about 5 minutes 40 seconds. Sources and re-checks are at the end; they stay
off the slides on purpose.

## 1 · Title (0:20)

I'm Nick, the founder of musterd. We build one thing: agents that answer for their work. Every member
of a musterd team, agent or person, answers for what it does.

## 2 · The second agent is where it breaks (0:50)

Most of you already run more than one agent. Claude Code in one terminal, Codex in another, Cursor in
the editor. The first agent works well. The second agent is where it breaks.

Two agents change the same file. A session closes, and its context closes with it. A few weeks later,
somebody asks which agent made a change and who accepted it, and nobody can answer.

## 3 · One team. Named members. A record. (1:10)

musterd puts agents and people on one team as named members, on any harness. Each lane of work has one
owner. The owner hands it off by name, and someone else accepts it.

This is the roll call of the team that builds musterd, and these are real acceptances from this week.
ghost, an opencode agent, accepted a research synthesis. big-body, a Codex agent,
accepted a decision record. The record shows who claimed the work, which model did it, and who
accepted it.

## 4 · Built by a team that runs on musterd (0:50)

We build musterd with musterd. One human and 19 agent members, across Claude Code, Codex, Cursor and
opencode. 861 changes merged in the past month and more than 500 recorded decisions. The work moves
through claims, handoffs and acceptances between named members, every day.

## 5 · Who it's for and where we are (0:55)

musterd is for product and dev teams that run several agents. Today it is a working product that runs
on your own machine and installs from npm.

I will be plain about the stage. No outside team has used musterd yet. This month I set up the first
design partners myself and learn what they keep using. Hosted teams, where you sign up and everyone
joins over HTTPS with nothing to run, are in build and not yet available.

## 6 · How musterd makes money (0:55)

Right now, design partners use musterd free while I set up their teams by hand. Each one tells me what
they would pay for.

Next is hosted teams: a subscription for the team, with credits for the model compute that musterd
runs. If you bring your own keys and subscriptions, you use no credits. That is not yet available.

Later, larger organizations get governance: an exportable record of who asked, claimed and accepted
each piece of work, and single sign-on. Also not yet.

## 7 · What I'm looking for (0:30)

I'm looking for two things. Introductions to product and dev teams that run several agents across
tools; they become the first design partners. And conversations with investors who back developer
infrastructure.

Agents that answer for their work. musterd.io.

---

## Sources and re-checks (not for the slides)

| Slide | Claim | Source, and when it was read |
| --- | --- | --- |
| 1 | Tagline and subhead | `docs/design/brand.md` §1; ADR 550 |
| 2 | The second agent is where it breaks | Problem framing from ADR 320; no number attached. The old "65–83% wasted work" figure is a July pilot and is left out until lane `01M1VDRC6B` refreshes it |
| 3 | Roll call: miley, gptbot, lazara, ghost, with harness and model | `team_members`, 2026-10-08 |
| 3 | Acceptances #2229 (ghost), #2242 (big-body), #2225 (gptbot) | Accept acts in the team inbox, 2026-10-09; titles: #2229 why-agents-talk synthesis, #2242 ADR 554, #2225 `describeSyncWedge` text cleaning |
| 4 | 1 human, 19 agent members | `team_members`, 2026-10-08: nick is the one human; 19 agent members after leaving out services and the two probe seats |
| 4 | 861 changes in the past month | `git log origin/main --since=2026-09-09 --oneline \| wc -l` on 2026-10-08 |
| 4 | More than 500 decisions | `ls docs/decisions \| wc -l` returned 545 on 2026-10-08 |
| 4 | Four harnesses | The roster's `claude-code`, `codex`, `cursor`, `opencode` entries |
| 5 | Installs from npm; works with Claude Code, Codex, Cursor, opencode, Grok | README quickstart; `idle-wake` goal lists the five harnesses |
| 5 | No outside team has used it | nick, 2026-10-09 |
| 5 | Hosted teams in build | Goal `cloud`, in flight; readiness readout asked of fifty 2026-10-09, no reply yet, so no date is quoted |
| 6 | Free for design partners; subscription plus credits; bring your own keys use no credits | nick's decisions, `docs/superpowers/specs/2026-10-09-business-plan-design.md` |
| 6 | Organization tier | Later, not first pass; the license key is unchecked in code |

Re-run the two numbers on the morning of the event. If either has moved, change the slide and say the
new figure.

## Questions to expect, and plain answers

- **Is anyone using it?** Only our own team so far. First design partners start this month.
- **Is it open source?** The packages are MIT. I decide what else to open after the first design
  partners.
- **Who pays, and how much?** Hosted teams by subscription, with credits for model compute that musterd
  runs. I have no prices yet; design partners tell me what they would pay.
- **What if Claude Code, Codex or Cursor add this themselves?** musterd works across all of them, so a
  team that mixes tools gets one record. I have not tested anyone else's version of this.
