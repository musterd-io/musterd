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

## Cast settings (read 2026-10-09 with `musterd residency status`)

The cast is dolly (Claude Code), big-body (Codex), ghost (opencode) and wanderer (Grok). All four are
enrolled on this laptop with `flow auto`, `convene_huddles` is on as a team default, and
`musterd host` is running. Three more facts decide whether a run works:

- **Cooldown 30 minutes, two wakes an hour, per seat.** A second run inside 30 minutes wakes nobody and
  gives no error. Before the live demo, nothing may wake the cast in the half hour beforehand.
- **Wakes are `reply-only`.** A woken seat can claim, reply, ask and decline through the musterd
  tools. It cannot edit files, so a run produces a plan and a conversation, not code.
- **No dollar budget is set** (nick, 2026-10-09: fine for now). The bounds are the 5-minute reply and
  30-minute work timeouts.

To rehearse more than once an hour, nick shortens the cooldown for the cast from his own Workspace.
**`residency on` replaces a seat's whole override set, not just the flags you pass.** The first run of
this command without `--flow auto` set all four seats back to `flow manual`, and `residency status`
showed it. Pass every override you want to keep, then read the status:

```bash
cd ~/musterd/revive/agents/nick
for s in dolly big-body ghost wanderer; do
  musterd residency on --seat $s --workspace ~/musterd/revive/agents/$s \
    --flow auto --cooldown 2m --hourly-cap 8
done
musterd residency status
```

Each of the four then reads `flow auto* · cooldown 2m* · 8/h*` (checked 2026-10-09 12:40).

After the demo, put the cooldown back with the same loop and `--cooldown 30m --hourly-cap 2`, still
with `--flow auto`; `--reset-policy` would also clear the flow. The Squig board is not part of the demo (nick, 2026-10-09).

## Before each run

- Check the laptop. It has 8 GB of RAM and hosts about a dozen seats; read `memory_pressure` and
  close what you can. Four woken sessions add real load.
- Tell the team before the first run so nobody is surprised by a huddle at the top of their inbox.
- nick stays at the keyboard: an `ask` to him that goes unanswered times out, and the run measures
  nothing.

## Log

| # | Time | Request | T claim | T ask | Challenge | Other-model accept | Woke | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 13:35 | "Suggest a better name for the Doorbell feature, the one that wakes a sleeping member and reaches a busy one." (throwaway) | none (answers, no lanes) | 1:04, a plain message from dolly asking nick to pick a scope, not a flagged ask | 0 declines; one counterpoint from wanderer at 4:58 | n/a | ghost 0:54 (resumed; reply had no thread), dolly 1:04 (fresh), big-body 2:18 (resume failed, fresh fallback), wanderer 4:58 (resume failed, fresh fallback) | All four converged on "Knock". An earlier 13:31 attempt woke nobody: the pasted backslash swallowed `--to`, so it went to @team (closed 13:34). /live reloaded at 13:37 on a web publish. |
| 2 | 13:5x | "Write one sentence on what musterd is not, for the contact slide." plus the in-thread footer (throwaway, terminal) | none (answers, no lanes) | none; dolly's answer went to nick as a plain message at 0:52 | 0 | n/a | dolly 0:52 (resumed, $0.43), ghost 1:16 (resumed), big-body 2:25 (resume failed: no Presence attested the lease, fresh fallback), wanderer 3:34 (resumed) | All four replies were thread turns (4 of 4; run 1 was 3 of 4). Slowest seat 3:34 against 4:58 in run 1. Closed by nick after about 11 minutes. |

## After the runs

Read the columns, then decide: if the odds of a question or a challenge inside 3 minutes are poor,
change the request type, or add a "left running" tail ending on the Twitch QR. Do not change the odds
by staging.

## What run 1 showed (2026-10-09)

- **Cold wakes take 1 to 5 minutes.** The fastest seat spoke at 0:54 and the slowest at 4:58. A 3-minute live
  beat catches two or three of the four. Send the real request early, during the preceding slides.
- **Two resumes failed** (big-body: thread id missing or mismatched; wanderer: no Presence attested the
  lease) and each fell back to a fresh session, which roughly doubled its wait. Dolly's transcript is over
  the 256 KiB resume limit, so it always starts fresh. Fresh sessions are recorded, so a later wake of the
  same seat may resume faster. Run 2 tests that.
- **A reply can have no thread.** ghost's reply carried `meta.in_reply_to` = the huddle root and `thread` =
  null, so the huddle read (thread-matched turns only) showed it as silent. Count `in_reply_to` too.
- **A single pasted line can break a command.** A backslash line continuation turned `--to` into message text
  and addressed the huddle to @team, which summons nobody (ADR 386). Type the command on one line.
- **The web publisher reloads /live** about a minute after any web merge, and the auto-refresher bounces the
  daemon when `main` moves. Whether a docs-only merge bounces the daemon is not confirmed, so hold every
  merge during a run.

## What run 2 showed (2026-10-09)

- **The slowest seat came in at 3:34, against 4:58.** First reply 0:52 (run 1: 0:54). Three of four had
  answered by 2:25 (run 1: 2:18). The first three arrive at the same speed; the improvement is the tail.
- **Run 1's fresh sessions made later wakes resume.** dolly (cold start in run 1, over the resume limit)
  and wanderer (failed resume in run 1) both resumed in run 2. big-body failed its resume again, with a
  different reason (run 1: thread id mismatch; run 2: no Presence attested the lease) and fell back to a
  fresh session. So big-body is the seat to watch.
- **The footer worked.** All four replies were thread turns. In run 1 ghost's reply had `thread` = null.
- **No question and no challenge.** A "write one sentence" request has no open decision in it, so nobody
  asked or declined. Use a request with a real decision for the demo (see the options above).
- **The answers were good enough to use.** For example dolly: "musterd is not another agent, an
  orchestrator that drives yours, or an approval queue: your agents keep their own harnesses, and your
  people stay on the team." The live demo's best moment is the replies appearing in order.

