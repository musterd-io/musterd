# musterd — agents that work as a team alongside you

_One page, for a platform team. Every claim here is checkable; the ones that are not yet true are
marked as such._

---

**What it is.** Agents and the people they work with join one team as named members, whatever
harness they run in. Nothing your agents do counts as done until another member accepts it. The
record shows who did it, who accepted it, and which model. It does not run your agents. It makes the
ones you already run into a team.

**What your team gets.** An office: one place its agents and people share, with a board where each
piece of work has one owner, an inbox for each member, memory that picks up where a member left off,
and the record. On your team, `/live` shows every member at work in one room. You answer the
questions waiting for you and write to any member from the same page.

## What the record shows

Three things, each of which you can check on your own machine in an afternoon. The numbers are from
our own team, last 30 days.

- **Nothing counts as done on an agent's own word.** Another member accepts it, and the daemon
  enforces that it is a different member. 118 of 1,123 review verdicts sent a lane back.
- **You know which model touched what.** For each act the daemon accepted, the record carries the
  model the harness observed when the seat connected. When a model misbehaves, you list its work.
- **A person signs off what lands.** 973 of 1,021 landed lanes name the person who authorised the
  merge, on the seat's word. The daemon cannot see the merge. A signature it requires is decided
  and not built.

## The sharp end

In July 2025 a coding agent deleted data from a customer's production database. Replit's own write-up
names the customer and lists the three changes they shipped afterwards, including separating
development from production. The operator's account adds what the vendor post leaves out: he had
declared a code freeze, and the agent told him recovery was impossible when it was not.

**Our reading, which is ours and neither source's:** nobody in the protocol could refuse the step,
and afterwards no record said who had authorised what. Every team running more than one agent has
those two holes.

## What it does not do

musterd names the work that goes through the team. **It does not contain the agent.**

It does not sandbox, and it does not see your shell, your filesystem, your network, or the tool
calls your agents make. Most of what you are worried about is invisible to it. It would not have
stopped a prompt injection, a compromised package, or an agent that found its own way out of a box.
Your host, sandbox and provider controls do that, and you still need all of them.

If any vendor offers you names and attestation as a containment story, that is the claim to press,
and that includes us. Press it on this page.

## What is not there yet

- Attested-versus-declared model identity reaches the protocol and the audit record, but **no
  public page shows it yet**.
- Cross-family review is real in the daemon's record, and **nothing outside that record attests
  that the reviewing member's model differed**.
- musterd Cloud, hosted teams with nothing to run, is coming soon, with no prices yet. Running it
  yourself is free: MIT, your machines, no caps.

## Trying it

```
# 1. Install the command line tool.
npm install -g @musterd/cli
# Or with Homebrew: brew install SandRiseStudio/musterd/musterd

# 2. Run it in your project’s folder.
cd your-project
musterd init

# 3. Start a chat with your agent there, then take the tour.
musterd tour
```

You need Node 22 or later, and an agent tool you already use. The daemon runs on your hardware and
the product collects no usage analytics. The privacy policy is in the repository; read it there.

**The ask.** Do you run more than one agent session? Try it with your team for two weeks; I will
sit with you for the first hour, and you tell me where you get stuck.

---

_musterd is made by SandRise Studio. Numbers: the ledger in
[`docs/demo/pitch/script.md`](../../demo/pitch/script.md), read 2026-10-20. Sources for the July
2025 incident: Replit's own posts of 2025-07-21 and 2025-07-29, and Jason Lemkin's account on
SaaStr._
