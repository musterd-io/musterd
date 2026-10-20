# musterd — agents that work as a team alongside you

_One page, for an investor. Every claim here is checkable; the ones that are not yet true are marked
as such, and the traction numbers are the real ones._

---

**What it is.** Agents and the people they work with join one team as named members, whatever
harness they run in. Nothing your agents do counts as done until another member accepts it. The
record shows who did it, who accepted it, and which model. Every team gets an office: one place its
agents and people share, with a board, inboxes, memory and that record.

**The wedge.** The loud problem in agents is one process driving sub-agents, and it is moving into
the harnesses and model APIs themselves. musterd covers the space between agents that already exist
independently and that nobody centrally owns: a team's agents from different vendors, and the
people beside them. It does not run your agents.

## The scope decision, which is the whole bet

musterd names the work that goes through the team. **It does not contain the agent.**

It does not sandbox, does not see the shell, filesystem, network or tool calls, and would not have
stopped a prompt injection or a compromised package. We chose that boundary. The adjacent product,
a control plane between the agent and the world, is larger, slower, more regulated, and has to be
right about everything. Ours has to be right about one thing: that work between independent actors
has an owner, an acceptance and a record.

**The objection, which we would rather state than be asked.** Money in this cell has gone to the
bigger product: Band raised a $17 million seed and xpander a $7.5 million seed. A small team
finishing it is a reason to decline the control plane, and a weak reason to prefer the smaller
company. Our reason is where we looked: the 2026 wave adopts the same nouns (named persistent
agents, handoffs, boards) and stays inside one owner's walls. We have not tested their products.

## What we can show today

- **It is built by a team running on it**, in public, on a live stream. On our own team 2,090 lanes
  are closed and 2,329 asks went to a member, with acts on 101 of the 111 days since 2026-07-02.
- **Nothing counts as done on an agent's own word.** In the last 30 days, 118 of 1,123 review
  verdicts sent a lane back, and the daemon enforces that the reviewer is a different member.
- **A person signs off what lands.** 973 of 1,021 landed lanes name nick as the authoriser, on the
  seat's word. The daemon cannot see the merge. A signature it requires is decided and not built.
- **A person's place on the team is `/live`.** On your team, it shows every member at work in one
  room. You answer the questions waiting for you and write to any member from the same page.

## Traction, unflattered

- **GitHub: 1 star** (2026-10-20).
- **No install outside the team is logged** (2026-10-20). The product collects no usage analytics,
  so installs are hand-counted from conversations, and none has been recorded yet.
- **npm downloads are not reported here.** The registry's weekly totals include mirror crawls, and
  we have not separated them.
- **Design partners: none yet.** The first conversations have not started.

## What is not decided, and is not a secret

**There are no prices.** The first design partners will tell us. Running it yourself is free: MIT,
your machines, no caps. musterd Cloud, hosted teams with nothing to run, is coming soon: a
subscription with caps on teams, people and history, and credits for model compute that we run. An
organization tier with single sign-on and signed audit export is also coming soon. None of it is
for sale.

## The risk we would raise ourselves

The record holds the accepted end of the chain. The start is partly recorded: of the 188 lanes
opened since 2026-10-16, 98 name a person as the one who asked, 70 name no one and 20 name an agent. The page claims
who did the work, who accepted it and which model. A person at the start of every piece of work is
where we are heading, and the record does not hold it yet.

## The ask

**Do you run more than one agent session, or know a team that does?** Try it with your team for two
weeks; I will sit with you for the first hour. An honest account of where it broke is the first
thing we want from this conversation.

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

You need Node 22 or later, and an agent tool you already use.

---

_musterd is made by SandRise Studio. Numbers: the ledger in
[`docs/demo/pitch/script.md`](../../demo/pitch/script.md), read 2026-10-20. Funding figures:
[landscape](../../design/landscape.md) §5 (Band) and §13 (xpander)._
