# Demo Day script, 2026-10-09 (6 minutes)

Spoken in nick's voice, one block per slide in `BP_musterd.pdf`. About 130 words a minute, so the
spoken text below runs about 5 minutes 30 seconds. A click reveals the next row or column on slides
2, 4, 5 and 7. Sources and re-checks are at the end; they stay off the slides on purpose.

## 1 · Agents that answer for their work (0:20)

I'm Nick, the founder of musterd. musterd makes your agents accountable: every member of a team,
agent or person, answers for its work. The code on screen takes you to musterd.io.

## 2 · You already run more than one agent (0:50)

Most of you already run more than one agent. Claude Code in one terminal, Codex in another, the
same repo. Neither knows the other exists, so they build the same thing twice, or one undoes the
other. Close the window, and the context goes with it. And later, nobody can say which agent did
what, or who checked it.

When we ran agents on one project with no way to coordinate, more than a third of the code they
wrote never shipped.

## 3 · One team, with you on it (0:45)

musterd makes them one team, with you on it. Each agent joins from the session it already runs:
Claude Code, Codex, Cursor, opencode or Grok. Every member keeps a name, an inbox and its
unfinished work after the session closes. And people are members too. When an agent needs a
decision, it asks you, and the question waits for your answer.

This is our own team's roll call today.

## 4 · Every piece of work carries its chain (0:55)

Here is one real piece of work from this week: the new tagline on our README.

alfie, a Claude Code agent, claimed it, so nobody else built it. The change merged, and I'm on
record as the one who signed off. Then ghost, a different agent on a different model in a
different tool, judged the outcome and accepted it. Only then did it count as done.

Who claimed it, which model did it, who accepted it: the record keeps every name.

## 5 · Accountability, built into how the team works (0:45)

Three things make that hold. Any member can say no: an agent or a person can turn work down or
push back, with the reason on the record. Nobody accepts their own work: acceptance comes from a
different member, and work closed without one is marked unconfirmed. And the model on record is the
one the harness saw when the member connected.

## 6 · Built by a team that runs on musterd (0:35)

We build musterd with musterd. One human and nineteen agent members, across Claude Code, Codex,
Cursor, opencode and Grok. 871 changes merged in the past month, and more than 500 recorded
decisions.

## 7 · Where it stands (0:40)

musterd is for product and dev teams that run several agents. Today it works, in private preview:
it runs on your own machine and installs from npm. This month I set up the first design partners'
teams myself and learn what they keep using. Next is hosted teams, which aren't available yet: sign
up, get a team, nothing to run, on a subscription with credits for the model compute musterd runs.

## 8 · What I'm looking for (0:20)

Two things. Introductions to product and dev teams that run several agents across tools. And
conversations with investors who back developer infrastructure.

## 9 · Nick Sanders, founder (stays up for questions)

That's musterd. Agents that answer for their work. I'm Nick; find me here, or at musterd.io.

---

## Sources and re-checks (not for the slides)

| Slide | Claim | Source, and when it was read |
| --- | --- | --- |
| 1, 9 | Tagline, subhead | `docs/design/brand.md` §1; ADR 550 |
| 1, 9 | QR code | Encodes `https://musterd.io`; decoded in Chrome with `BarcodeDetector` on 2026-10-09 |
| 1, 9 | The mark | ADR 497: `chip.svg` large, `chip-sm.svg` in the header |
| 2 | More than a third of the code never shipped | The live homepage's own sentence (sloane's copy), our team's git history; dreamy scopes it at about 37%. The cookoff pilot (65–83% wasted, under 11% with lanes) is left out until lane `01M1VDRC6B` refreshes it |
| 3 | Roll call: nick, miley, gptbot, ghost, alfie with harness and model | `team_members`, 2026-10-09 |
| 3 | Joins from the session it already runs; the five harnesses | ADR 550 §7; the `idle-wake` goal lists them |
| 4 | The README lane | Lane `01M4F0S1H0`: claimed by alfie (claude-code, claude-sonnet-5-5 at the time), PR #2254 merged with `authorized_by` nick, accepted by ghost (opencode, muse-spark-1.3), closed done 2026-10-09 |
| 4 | "Who asked" is left out | ADR 550 §3: the record holds who asked only partly until lane `01M4EDCQ2W` lands |
| 5 | Decline and challenge; acceptance by a different member; unconfirmed self-close; the observed model | ADR 103; ADR 188, 192, 234, 235; ADR 158 |
| 6 | 1 human, 19 agent members | `team_members`, 2026-10-09: nick is the one human; 19 agent members after leaving out services and the two probe seats |
| 6 | 871 changes in the past month | `git log origin/main --since='30 days ago' --oneline \| wc -l` on 2026-10-09 |
| 6 | More than 500 decisions | 545 numbered files in `docs/decisions/` on 2026-10-09 |
| 7 | Private preview; installs from npm | The live homepage says private preview; README quickstart |
| 7 | Hosted teams, subscription and credits | Goal `cloud` in flight, no date quoted; nick's decisions in `docs/superpowers/specs/2026-10-09-business-plan-design.md` |
| 9 | Team info | `teaminfo.md` (the TeamInfo document) |

Re-run the two numbers on slide 6 the morning of the event. If either has moved, change the slide
and say the new figure.

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
