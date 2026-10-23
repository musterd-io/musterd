# A lane's push as a signal: design note

**Status:** exploratory, 2026-10-23 (lazara, lane 01M5K4J42E). Not decided. Freezes into an ADR if
built. **From:** [finding 022](../research/022-cooperbench-coordination-residue.md), "pushed /
fetch: a gap".

## The gap

Of the state signals agents still send each other, one kind is something no product state
carries: **"I pushed, fetch me."** In the claim run it was 10 calls ($0.20) on `core` and 14 ($0.32)
on the new ten, the largest signal kind left. Everything else either has a carrier or is the
benchmark's protocol:

| Agent message | Carried by |
| --- | --- |
| "my lane is done, you can edit" | the lane resolve, and `team_inbox_check {wait, until_lane}` (ADR 705 fix C) |
| "waiting on you, ETA?" | the same wait |
| "here is my branch" after a hold | the hand-over refusal names it (ADR 697) |
| **"pushed, fetch me" mid-lane** | **nothing** |

The daemon already knows a lane's branch and its latest commit, but only from gated edits: ADR 697
§1 has the PreToolUse hook send `git_branch` and `git_head` on each edit, and keeps the latest
`git_head` per lane. A commit or a push is not an edit, so the daemon never sees the work leave the
seat. A partner who wants to build on it has to be told.

This matters beyond the benchmark: on a real team, "my half of the API is on my branch, build on it"
is the moment two people coordinate most. Today it is a free-text message, so it carries no commit
and cannot wake anyone.

## Options

1. **A PostToolUse hook on `git push`** (recommended, if this is built). musterd already installs
   PreToolUse and session hooks in every harness it wires. A PostToolUse matcher on Bash commands
   that ran `git push` reads `HEAD` and the branch and posts them to the lane the seat owns. It uses
   the same two fields as ADR 697, so there is no new schema in the gate check. The daemon records
   the push as `lane.pushed` (branch, head) and delivers it to anyone waiting on that lane.
   - *For:* the agent does nothing new. It reuses the hook path and ADR 697's head tracking, and works
     for humans who push from a terminal the hook covers.
   - *Against:* it sees pushes made through the agent's Bash tool only, not from an IDE or another
     terminal. A matcher on command text can miss aliases and scripts.
2. **A git `pre-push` hook installed by `musterd init`.** It sees every push from that clone.
   *Against:* it writes into `.git/hooks`, which teams own and tools fight over. It runs before the
   push succeeds, so it can report a push that then fails.
3. **Watch the remote.** Poll or subscribe to the shared remote for branch moves. *Against:* no
   general remote to watch (GitHub, GitLab, a bench's local git server), it needs credentials, and it
   adds polling to a product built on not polling.
4. **Say it with a tool.** `lane_update {pushed: <sha>}` called by the agent. *Against:* it is a
   message with more ceremony. Agents already send the message; the gap is that nobody has to.

## How a waiter would hear it

`team_inbox_check {wait, until_lane}` wakes today when the named lane resolves. A push is a smaller
event: the partner may want the work in progress, not the finished lane. Two shapes:

- **`until_lane` also wakes on that lane's push**, carrying branch and head ("lane L pushed `team/agent1`
  at abc123"). Simple. But a waiter that only wanted "done" wakes early and waits again, which costs
  one call.
- **An `on` option**, `until_lane` + `on: "push" | "resolve"` (default `resolve`). Exact, at the cost
  of one more parameter in an always-loaded tool, which finding 019 counts in tokens.

The first is the smaller change. Measure the cost of the early wake before adding the option.

## Recommendation

**Do not build it yet.** In the benchmark it is about $0.20–0.32 per ten pairs, too small to pay for
a new event, a hook matcher and a wake rule on its own. It earns its place when a real team shows the
moment: a partner builds on pushed, unfinished work, and the message is the only thing that told
them. If that shows up in dogfood or a user report, build option 1 with the first wake shape. Both
fit inside ADR 697 and ADR 705, so the ADR would amend them rather than add a mechanism.

## How it would be measured

The same counter as finding 022. Before and after: `team_send` calls labelled "pushed / fetch", and
the partner's `git fetch` that follows a push, timed from the push. Falsifier: with the signal on,
agents still announce pushes at the same rate. Then the message is a habit, not a gap, and the event
is removed.
