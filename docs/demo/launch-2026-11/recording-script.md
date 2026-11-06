# The two-minute recording — script for the launch video

- Status: script (comms, sloane), 2026-11-06. nick records it. Lane `01M6S6W6BQY7EE8FBKMHZHMEV2`, goal
  `launch`.
- Source: the live two-minute cut, [`docs/demo.md`](../../demo.md) §6 (refreshed 2026-10-20). The beats
  and the claims are §6's. This file changes what a recording needs and a room does not: a muted
  first frame, captions, an end card, and a take plan.
- It unblocks: the launch post ([`docs/launch-post.md`](../../launch-post.md), "the one asset still
  missing is the recording"), the Show HN source pack beside this file, and every listing in
  [`directory-listings.md`](./directory-listings.md).

## What the video has to do

A stranger watches it on X, LinkedIn or the README, often muted, often only the first ten seconds.
In two minutes they see one thing happen: **an agent asks a person a question, the person says no,
and the work goes where the person sent it.** Everything else in the video sets that up or shows the
record it leaves.

Hard limits:

- **2:00 or less.** About 244 spoken words, counted 2026-11-06. The table below is the count; re-time it with a stopwatch
  after the first take and replace the table if they disagree.
- **A person is in every frame.** ADR 320 decision 5c, restated in [`demo.md`](../../demo.md) §3: the
  roster with nick on it is visible the whole time. Never a frame of agents only.
- **No secret on screen, ever.** No `mscr_`, `mskey_`, `msat_`, `msnode_` value in a terminal, a
  config file or a URL bar (AGENTS.md hard rule 5). Run `musterd whoami` before recording; never
  `cat` a config.
- **The real team, live.** Not a fixture and not a mock. Retakes are fine; staging the result is not.
- **No number the ledger does not hold.** The one figure is 37% → 0.9% (ledger row 2 in
  [`docs/demo/pitch/script.md`](../pitch/script.md)). The cookoff multiplier stays out
  ([`docs/wiki/how-musterd-got-here.md`](../../wiki/how-musterd-got-here.md), held).

## Before you press record

1. Screen at 1920×1080. Browser zoom so `/live`'s roster names read at phone width (125–150%).
   Terminal font 18 pt or larger, dark theme, nothing else on the dock or the menu bar.
2. `/live` open on the team, office lit, nick present, two agents `here`. A terminal beside it with
   `musterd inbox --watch`.
3. One small real task, split by ownership into two pieces, ready to hand to the two agents.
4. One agent primed in plain words: *"when I say go, raise a standard-tier ask to nick about the
   task, with a choice I can say no to."* §6's "If it goes wrong" covers a prime that does not fire.
5. Notifications off. Close every tab that shows email, chat or a credential.
6. Record screen and voice as separate tracks if the recorder allows it. Then a fluffed line costs a
   voice retake alone.

## The script

**SEE** is the screen. **DO** is what you do. **SAY** is the voiceover; it is the only thing that
spends the clock. **CAPTION** is burned into the frame for muted viewers, short on purpose.

| beat | budget | spoken words | at 150 wpm |
| --- | --- | --- | --- |
| 0:00 cold open | 8 s | 0 | — |
| 0:08 the roster | 18 s | 45 | ~18 s |
| 0:26 the second agent | 22 s | 50 | ~20 s |
| 0:48 the ask (centerpiece) | 42 s | 80 | ~32 s |
| 1:30 two claims, and the chain | 20 s | 48 | ~19 s |
| 1:50 end card | 10 s | 21 | ~8 s |
| **total** | **120 s** | **244** | **~98 s** |

### 0:00 — Cold open (8 s, no voice)

**SEE** The answered ask from later in the video, cut in as a flash-forward: the ask on `/live`'s rail,
nick's "no" under it, the lane moving on the board.

**CAPTION** `An agent asked me a question. I said no. Watch the work move.`

Cut it in last, in the edit, from the take of beat 3. A muted viewer decides in these eight
seconds.

### 0:08 — The roster (18 s)

**SEE** `/live`. A roster of names. One of them is nick.

**SAY** "This is our team on musterd. Agents and people, named members on one roster. One of them is
me. By default, nothing they do counts as done until another member accepts it, and the record shows who did
it, who accepted it, and which model."

**CAPTION** `Agents and people on one team.`

### 0:26 — The second agent is where it breaks (22 s)

**DO** Hand the two agents the task, split by ownership. Each claims a lane.

**SEE** The board: two owners, two scopes. If a scope overlaps, the warning fires.

**SAY** "The moment you run a second agent on one repo, the waste starts. On our own team, 37% of the
code our agents wrote never reached main before musterd had a board and review. After, 0.9%. The fix
is one owner for each piece of work, declared before anyone starts."

**CAPTION** `One owner for each piece of work.`

Spoken "37%" and "0.9%" carry the figure; the caption leaves them out, so a muted viewer never meets
a number without its source. The source goes in the post's text (§"Where the video goes").

### 0:48 — A question reaches the person (42 s, the centerpiece)

**DO** "Go." The primed agent raises its ask.

**SEE** The ask lands on `/live`'s rail with its clock drawn as an arc, and in the terminal inbox.
Hold one breath on it. Answer from `/live` as yourself: decline. The agent re-routes, and the lane
moves on the board.

**SAY** "It asked me. Not the person driving its session. Me, a member on the same roster, with a
clock on the question. Above a certain stakes tier it holds until I answer. Below it, it goes ahead
when the clock runs out and writes down that it went on without me. From /live I see every member at
work and answer what's waiting for me. So I answer here. I say no. And the work goes where I sent
it."

**CAPTION** `It asks a person. I say no. The work moves.`

This is the beat to protect. If the take runs long, trim the other beats around it.

### 1:30 — Done is two claims, and the chain (20 s)

**SEE** A lane in awaiting-acceptance, its acceptance routed to a different seat. Then, in the
terminal:

```bash
musterd lane show <lane id>
```

**SAY** "The agent that built it says it's merged. A different member accepts it, on a different model
family when the roster has one. That's two claims. One command prints the chain: who asked, who
claimed, which model, who accepted. Each link says whether it's verified, stated or missing."

**CAPTION** `Done: another member accepted this one.`

Say "verified" only as the screen shows it ([`demo.md`](../../demo.md) §6 note: ADR 629, #2771).
Independence of the acceptance is not claimed (ADR 670).

### 1:50 — End card (10 s)

**SEE** A still card, brand colors, the wordmark, then two lines and a URL:

```
npm install -g @musterd/cli
musterd init
musterd.io · github.com/musterd-io/musterd
```

**SAY** "It's open source and free to run yourself. Install it, run musterd init in your project, and
your agents join you."

Hold the card two seconds after the voice ends. The install lines are the generated block in
`README.md` (`content/install.data.ts`, ADR 669). Re-read it on recording day; if it changed, the
card changes.

## After recording

1. Edit: cold open from beat 3's take; trim dead air; keep the agents' real response time visible at
   least once (it shows the team is real).
2. Captions: burn the CAPTION lines in, large, bottom third. Also export an `.srt` of the full SAY text
   for players that support it (X, LinkedIn, YouTube). A muted viewer gets the captions; a
   screen-reader user gets the `.srt`.
3. Exports: 1920×1080 MP4 for YouTube and the README link; a square 1080×1080 cut for X and LinkedIn
   with the roster cropped in, nick's name still in frame.
4. Before it goes anywhere: watch it once with the sound off and once at phone size. Scrub every frame
   for a credential, an email address or a private channel.
5. Put the file where the launch post links it, and fill the post's recording link.

## Where the video goes, and the text beside it

- **README:** a still with a link to the video, under the Quickstart.
- **Launch post** ([`launch-post.md`](../../launch-post.md)): the post's existing text, with the link.
- **X / Bluesky / LinkedIn:** the square cut, with one line and a source for the number:
  `On our own team, 37% of what our agents wrote never reached main before musterd had a board and
  review. Now 0.9%. Our git history, one team, July and September.` Then the install line and the
  link.
- **Show HN:** the link only, in nick's own post ([`show-hn-source-pack.md`](./show-hn-source-pack.md)).
