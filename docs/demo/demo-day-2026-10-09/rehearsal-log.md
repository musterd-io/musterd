# Live demo rehearsals, 2026-10-09

The live beat is organic: nick types a real request in front of the room and the team answers it.
Nothing is staged, so the rehearsals measure the odds instead of fixing the content. This page holds
the method and the log. The demo plan itself is written after the numbers are in.

## What a run is

nick opens one huddle from his own Workspace, naming the cast. `--topic` and `--anchor` are required;
the anchor is where the output would land, and for a rehearsal it need not exist:

```bash
cd ~/musterd/revive/agents/nick
musterd huddle open --topic design:eyes --anchor docs/design/eyes.md \
  --to dolly,big-body,ghost,wanderer --turns 40 "<one real request, one sentence>"
```

A huddle names at most four seats, and only a named seat is woken (ADR 254, ADR 386). Convening
needs `musterd residency policy --convene-huddles on` and each cast seat enrolled with `--flow auto`;
both are admin settings, so nick checks them before run 1. A seat with a session already open in its
Workspace is not woken (ADR 485); the huddle waits in its inbox, so close those sessions first.

Start the stopwatch when the command returns. One run lasts 3 minutes, the length of the live beat.
Stop it on the first of: the 3 minutes end, or the team goes quiet for 60 seconds. Then close the
huddle so nobody keeps building on the clock: `musterd huddle close <id> --anchor-ref none
"rehearsal"`. A closed huddle summons nobody, and the daemon enforces no turn budget itself.

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

Choose the type, not the wording. A request with a real open decision in it tends to draw a question
or a challenge. A fully specified task just gets claimed and built. The three live options below are
each one sentence in nick's words. Paste nothing else into the huddle: the lane specs in
`docs/demo/multiplayer-ai-2026-10-01/options.md` stage a Voices and an Eyes plan, and using them
would make the run a script.

| Option | The sentence | Decisions only nick can make | Likely split in the cast |
| --- | --- | --- | --- |
| **A. Eyes** | "Give the musterd members eyes: let them look at the office through a vision model." | What a frame may show; who pays per look | A text-only model declines the vision lane |
| **B. Voices** | "Let the team talk out loud, and let me talk back." | The voice provider and its cost; who gets which voice | A member without audio output says it cannot test its own lane |
| **C. Fork and race** | "When a task is hard, run it on two members on different models in parallel, and let a third member judge the winner." | The budget; who may judge (never a racer) | A member refuses to judge work it raced on |

Those columns are guesses made before any run. The runs confirm or correct them.

Each run also leaves useful work behind only if the request is real. If a team declines a whole option
as already built or out of scope, write that in Notes: it is a result.

Between the three options, one run with a request the room invents ("X") tests that path cold. Use a
real one nick has not seen in advance.

Warm-up requests, if a run needs a smaller one, all real:

1. The one-line answer to "Why do agents need to communicate at all?" for the Q&A sheet.
2. A better name for the "Doorbell" feature.
3. A rehearsed answer to "What if Claude Code adds this itself?"

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
