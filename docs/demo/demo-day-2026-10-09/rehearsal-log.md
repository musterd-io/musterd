# Live demo rehearsals, 2026-10-09

The live beat is organic: nick types a real request in front of the room and the team answers it.
Nothing is staged, so the rehearsals measure the odds instead of fixing the content. This page holds
the method and the log. The demo plan itself is written after the numbers are in.

## What a run is

nick opens one huddle from his own Workspace, naming the cast:

```bash
cd ~/musterd/revive/agents/nick
musterd huddle open --to dolly,big-body,ghost,wanderer --turns 40 "<one real request, one sentence>"
```

A huddle names at most four seats, and only a named seat is woken (ADR 254, ADR 386). Convening
needs `musterd residency policy --convene-huddles on` and each cast seat enrolled with `--flow auto`;
both are admin settings, so nick checks them before run 1.

Start the stopwatch when the command returns. One run lasts 3 minutes, the length of the live beat.
Stop it on the first of: the 3 minutes end, or the team goes quiet for 60 seconds.

## What to write down

| Column | Meaning |
| --- | --- |
| Request | The sentence typed, word for word |
| T claim | Seconds until the first lane is claimed or a member says it is taking the work |
| T ask | Seconds until the first question lands on nick, or `none` |
| Challenge | `decline` or `challenge` acts in the 3 minutes: count |
| Other-model accept | Did a member on a different model family accept or review anything: yes or no |
| Woke | Which cast seats answered, and how many seconds each took |
| Notes | What broke, what was dull, what a room would have liked |

## The request type

Choose the type, not the wording. A request with a real open decision in it (a name, a line of copy,
"which of these two") tends to draw a question or a challenge. A fully specified task just gets
claimed and built. Use real work each time, so a run leaves something useful behind:

1. The one-line answer to "Where do agent messages and actions live?" for the Q&A sheet.
2. The one-line answer to "Why do agents need to communicate at all?"
3. A better name for the "Doorbell" feature.
4. One sentence on what musterd is NOT, for the contact slide.
5. A rehearsed answer to "What if Claude Code adds this itself?"

## Before each run

- Check the laptop. It has 8 GB of RAM and hosts about a dozen seats; read `memory_pressure` and
  close what you can. Four woken sessions add real load.
- Tell the team before the first run so nobody is surprised by a huddle at the top of their inbox.
- nick stays at the keyboard: an `ask` to him that goes unanswered times out, and the run measures
  nothing.

## Log

| # | Time | Request | T claim | T ask | Challenge | Other-model accept | Woke | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## After the runs

Read the columns, then decide: if the odds of a question or a challenge inside 3 minutes are poor,
change the request type, or add a "left running" tail ending on the Twitch QR. Do not change the odds
by staging.
