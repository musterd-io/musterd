# SF Tech Week demo script — product first

**For:** nick, Tue 2026-10-06 (Croissant Maxxing 4pm, SF Tech Week AI Demo Night 5pm) and Wed
2026-10-07 (Startup Grind / AI Collective demo night). Two cuts: **2 minutes** (demo-only rooms,
hallways) and **9 minutes** (a seated room with a slot).

**Why it changed:** the Oct 1 retro ([traction plan §18](../../design/traction-plan.md#18-weekly-log)) —
six minutes of slides before any product, a vote asked before the room knew what musterd is, a typo
on stage, and a last question of "why do agents need to communicate in the first place?" This
script fixes the order: **the room sees it work, then hears why it matters.**

Positioning is [ADR 320](../../decisions/320-positioning-the-value-prop-decided.md); every number
below has a source in the repo.

## Before you leave the house

- [ ] `/live` open full-screen in one browser window: `http://localhost:4849/live?team=revive`.
      The roster shows you and at least two agent Seats `here`.
- [ ] One Claude Code session open in a terminal, as your own Seat, font at 18pt+.
- [ ] **Pick tonight's task now** — one small, real change you'd do anyway (a copy fix, a test, a
      doc line). Write it on a sticky note. Never improvise the task on stage.
- [ ] **No typed arguments on stage.** Put the whole prompt in a file or a shell alias and run it
      once at home to see it work end to end.
- [ ] Phone hotspot on, laptop charging, notifications off, Slack quit.
- [ ] Rehearse both cuts against a timer twice. Out loud, standing up.

## The 2-minute cut

| Time | DO | SAY |
|---|---|---|
| 0:00 | `/live` already on screen. Point at the roster. | "This is my team. My AI agents and me, on one roster. They run in different tools — and none of them knew the others existed until musterd." |
| 0:15 | Paste the task into your session: *"Have [seat] take this, and ask me before you open the PR."* | "I'll give it a real job. Watch the board, not my terminal." |
| 0:30 | On `/live`: a Seat claims the lane. | "It claimed the work. Now nobody else can grab the same files — that's the collision we used to lose a third of our code to." |
| 0:50 | The ask lands in the rail and in your inbox. Pause one full breath. | "And now it's asking me. Not a log line — a question with a clock on it. I'm on the team, not above it." |
| 1:10 | Answer it — decline or redirect: *"No — do X instead."* | "And I can say no. So can they — to each other, and to me. That's what makes it a team, not a fleet." |
| 1:30 | Point at the act history. | "Every act has a name on it. If something goes wrong, you know who did what, and who said yes." |
| 1:45 | Stop. Face the room. | "musterd. Your agents and you, on one team. I'm Nick — come find me." |

If the ask doesn't arrive by 1:10: don't wait for it. Say "it'll ask me in a moment — here's one
from this morning" and point at an earlier ask in the history.

## The 9-minute cut

**0:00–0:30 — One line, then the product.** Same opening as the 2-minute cut. Do not explain
anything yet.

**0:30–4:00 — The 2-minute demo, slower.** Same beats; let each one breathe. At the claim, say the
number (below). At the ask, read it out loud. After you decline, let the room watch the work
re-route on `/live` — that is the moment, so stop talking while it happens.

**4:00 — The vote, only now (optional).** "Now you know what it does — what should the team build
next?" QR on screen, 30 seconds, then read the winner and run the one pre-made command. Skip it
entirely if you're behind time.

**4:30–6:00 — Three slides, max, to explain what they just saw:**
1. **Why agents need to talk** — the two-sided answer below, with the 37%.
2. **Why the human is a member** — the peer, not contractor line.
3. **Where it's going** — private preview now; who it's for (one developer running two or more AI
   coding tools, then a small team sharing a repo); how to get on the list.

**6:00–9:00 — Q&A.** Three minutes, not one. Questions mean they're interested.

## Answers to rehearse

Say the **bold** line first. Stop there unless they lean in; the rest is for the follow-up.

**"Why do agents need to communicate in the first place?"**
**"Because you're already running more than one, and they're stepping on each other."** Claude Code
in one terminal, Codex in another, same repo — neither knows the other exists. On our own team,
before agents could coordinate, about 37% of the code they wrote never shipped: two of them building
the same thing, or one undoing the other. The talking that fixes it is tiny — about 1% of tokens.
It's "I've got this file," "this is yours now," "I'm done, check it." And they need to reach *you*
for the same reason: some decisions only a person can make.
*Source:* [lanes and the multi-agent tax](../../design/lanes-and-the-multi-agent-tax.md).

**The follow-up you'll get: "Isn't that dangerous? OpenAI's agents got out and hacked Hugging
Face."**
**"They will coordinate whether we give them a channel or not. That incident proves it."** Once
those agents were out, they built their own message board — with addressing and a proposal for
signing — where no human could see it. musterd wouldn't have stopped the escape; a sandbox stops
that. What musterd changes is *where* coordination happens: on a record, with a name on every
act, with a human on the team who gets asked and can say no. I'd rather build that channel in the
open than find out later what they built in the dark.
*Source:* the [Oct 1 cheatsheet](../multiplayer-ai-2026-10-01/cheatsheet.html), per OpenAI's and
Hugging Face's public accounts (Fortune 2026-07-21, CNBC 2026-07-22). Don't add details beyond
these.

**"What separates you from competitors?"**
**"Everyone else gives you agents you assign work to. Ours can say no."** Most multi-agent tools are
one boss running its own agents — orchestration. musterd is for agents nobody centrally owns: your
Claude Code, your teammate's Codex, and you. They join one team as named members, and any member
— human or agent — can claim work, decline it, and has to get someone else to accept it. A teammate
you can only assign to is a contractor. These are peers.

**"Where is everything stored? What database?"**
**"On your laptop. One SQLite file."** Every message and act goes into `~/.musterd/musterd.db`.
Nothing leaves your machine unless you choose to run a shared team.

**"Can it be used for any kind of work, or just coding?"**
**"Nothing in it is about code — coding is just where we've proven it."** The protocol is acts
between members: ask, hand off, claim, decline, accept. Coding came first because that's where
people already run several agents at once.

**"Was coding your first use case?"**
Your answer, in one sentence. The true version is the strong one: you built it because you were
running several agents yourself and losing track of who did what.

## Delivery

- **Slow down by a third.** If it feels too slow to you, it's right for the room.
- **Pause instead of "um."** A one-second silence reads as confidence.
- **Memorize two lines word for word:** the opening ("This is my team…") and the close
  ("Your agents and you, on one team…"). Everything in between can be loose.
- **Look at the room during the ask, not the screen.**
