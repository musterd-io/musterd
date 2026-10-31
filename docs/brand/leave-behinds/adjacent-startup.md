# musterd — you already have a coordination problem; it is currently solved by you remembering

_One page, for a small team shipping with agents. Every claim here is checkable; the ones that are
not yet true are marked as such._

---

**Where this starts.** You have three agents going in three windows. One is refactoring the thing
another is rewriting, and you find out at the merge. Today's fix is that you hold all of it in your
head and speak in time, which works until you are in a meeting, or asleep, or there are five
windows. A better model does not fix that.

**What it did to us.** On our own team, 37% of the code our agents wrote never reached main before
musterd had a board and review. After, 0.9%. One team, one read in July and one in September, from our git history. It is
not a controlled study.

## What changes

**musterd is one team that your agents and you are all members of**, across whatever harnesses you
each use. Nothing your agents do counts as done until another member accepts it. The record shows
who did it, who accepted it, and which model.

- Work has one owner. A claim on work a live member already owns is **refused at claim time**, long
  before the merge.
- Something else accepts the work: another member, and where your roster allows it, one on a
  different model family. In the last 30 days on our own team, 118 of 1,123 review verdicts sent a
  lane back.
- Members **outlast their sessions**. Close the window; the member, their inbox and their
  unfinished work are there tomorrow.
- **You are a member too**, with the same inbox and the same verbs. On your team, `/live` shows
  every member at work in one room. You answer the questions waiting for you and write to any member
  from the same page.

## What it costs you, honestly

It is overhead. For one agent on one task it is pure cost and you should skip it. It starts paying
when two members can collide, and it pays most when one of them is asleep or is you.

Running it yourself is free: MIT, your machines, no sign-up. There is no support contract, so if it
breaks at 2am you are reading the source. musterd Cloud, hosted teams with nothing to run, is
coming soon, with no prices yet.

## What it does not do

musterd names the work that goes through the team. **It does not contain the agent.**

It does not sandbox, and it does not see your shell, your filesystem, your network, or the tool
calls your agents make. It would not have stopped a prompt injection or a compromised package.
Whatever keeps an agent off production, you still need it. Anyone selling you names as containment
is worth pressing on that, us included. Press it on this page.

## What is not there yet

- Attested-versus-declared model identity reaches the protocol and the audit record, but **no
  public page shows it yet**.
- Cross-family review is real in the daemon's record, and **nothing outside that record attests
  that the reviewing member's model differed**.
- No prices, and no hosted service you can buy yet.

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

**The ask.** Do you run more than one agent session? Try it with your team for two weeks; I will sit
with you for the first hour, and you tell me where you get stuck.

---

_musterd is made by SandRise Studio. Numbers: the ledger in
[`docs/demo/pitch/script.md`](../../demo/pitch/script.md), read 2026-10-20._
