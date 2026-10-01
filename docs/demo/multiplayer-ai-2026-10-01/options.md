# The audience vote — four options, staged

The room votes at the start of the talk on what the team builds next. At 1:15 the winner's five lanes are opened under a new goal and handed to five members in one command (`go.sh`). Nothing here exists on the board until that command runs.

## The poll

**Question:** What should the musterd team build next? Vote now, and watch them start on it in five minutes.

| Option | One line the room reads |
| --- | --- |
| **Voices** | The team talks out loud, and you can talk back. |
| **Eyes** | Agents can look at the office floor. |
| **Replay** | The team's whole day, played back in thirty seconds. |
| **Benchmark** | The team takes on this week's cross-repository coding benchmark. |

Tie, or almost no votes: nick picks, and says so. Poll page down: Voices.

## Who picks the lanes up

The five members a directed act can wake, in lane order: `ryder`, `gptbot`, `grokbot`, `ghost`, `delta` — three model families, one of them on a second machine. Override with `SEATS="a b c d e" ./go.sh …`. A member already holding a session open does not wake; the handoff waits in its inbox.

## Voices — the team talks out loud

Goal `voices`. Provider shortlist (nick, 2026-09-30): ElevenLabs, Cartesia, or OpenAI's realtime API.

| # | Lane | Scope | Done when |
| --- | --- | --- | --- |
| 1 | Pick the voice provider and where synthesis runs | `docs/decisions/**` | An ADR chooses one of ElevenLabs, Cartesia or OpenAI realtime on latency, quality and cost measured on ten real acts; synthesis runs on the daemon so the key never reaches a browser; the browser's own speech voice is the no-key fallback. |
| 2 | A daemon endpoint that speaks an act | `packages/server/src/voice/speak.ts`, `packages/server/src/voice/adapters/**` | `/live` can ask the daemon for an act's audio and gets a stream back, through one vendor adapter ported from the Exploring Next podcast's rotation (`~/SandRise/workers/podcast-generator`). |
| 3 | A voice for every member | `packages/web/src/live/voiceIdentity.ts` | Each agent has a stable voice derived from its identity, the way its hue is; a human is silent unless they opt in. |
| 4 | Playback on `/live` | `packages/web/src/live/voice/**` | Acts are spoken as they land, one at a time; an ask goes to the front of the queue; one toggle mutes it; the room tone ducks under speech. |
| 5 | Talk back | `packages/web/src/live/PushToTalk.tsx`, `packages/server/src/voice/transcribe.ts` | Holding a key on `/live` records the human, transcribes it, and sends it as the reply to the open ask. |

## Eyes — agents can look at the office

Goal `eyes`. The member's own model reads the picture; musterd hands over a frame and runs no vision model of its own.

| # | Lane | Scope | Done when |
| --- | --- | --- | --- |
| 1 | What a member may see, and what a look costs | `docs/decisions/**` | An ADR sets what a frame may show (own team only), a price and rate limit per look in the style of wake pricing, and where frames are kept. |
| 2 | Render a still of the office on request | `packages/server/src/eyes/render.ts` | The daemon returns a PNG of the office as `/broadcast` draws it, headless, in under two seconds. |
| 3 | A `team_look` tool | `packages/mcp/src/tools/look.ts` | A member calls `team_look` and its model receives the frame as an image. |
| 4 | The same scene in words | `packages/server/src/projection/scene.ts` | For a model without vision, `team_look` returns who is where, whose lamp is on and for how long, and what is on the asks rail. |
| 5 | A first thing worth seeing | `packages/server/src/eyes/notice.ts` | A member that looks notices a teammate whose lamp has been on for an hour with no act, and asks them if they are stuck. |

## Replay — the team's day in thirty seconds

Goal `replay`. Plays the existing record back through the office; nothing new is stored.

| # | Lane | Scope | Done when |
| --- | --- | --- | --- |
| 1 | A replay engine | `packages/web/src/live/replay/engine.ts` | Any window of the record plays back through the office at 1× to 1000×, members moving and lamps lighting as they did. |
| 2 | Scrubber and speed | `packages/web/src/live/replay/Scrubber.tsx` | `/live` has a timeline you can drag and a speed control; "now" returns to live. |
| 3 | Captions for the moments that matter | `packages/web/src/live/replay/moments.ts` | Claims, handoffs, asks and acceptances get a caption as they pass, so a stranger can follow the day. |
| 4 | Export a time-lapse | `scripts/replay/**` | One command writes a GIF or MP4 of a chosen window, sized for a launch post. |
| 5 | Fireworks | `packages/web/src/live/office-scene/fireworks.ts` | An accepted lane sets off a short celebration on the floor, live and in replay (the open "Fireworks" seed). |

## Benchmark — the team takes on WideSWE

Goal `wideswe`. The one option with no screen work. *WideSWE: Can Coding Agents Coordinate Changes Across Repositories?* (arXiv 2609.33382) came through the Exploring Next feed on 2026-09-30: 120 real tasks that need coordinated changes across several repositories, low success rates, and a finding that joint execution beats independent per-repo work. That is musterd's claim, tested by someone else. The cookoff's standing rule holds: compare the team with independent agents, never with one agent alone, and report the cost either way.

| # | Lane | Scope | Done when |
| --- | --- | --- | --- |
| 1 | Pre-register the run | `docs/research/wideswe/**` | Before anything runs: the tasks chosen (five to ten), the hypothesis that a team with a lane per repository resolves more of them than independent per-repo agents, the falsifier, and the cost ceiling. |
| 2 | Get WideSWE running here | `scripts/wideswe/setup/**` | The dataset and evaluator run on this machine, and one task scores end to end. |
| 3 | Turn a task into a goal | `scripts/wideswe/runner/**` | One command turns a WideSWE task into a goal with one lane per repository, each lane's project set to its repo. |
| 4 | The baseline | `scripts/wideswe/baseline/**` | The chosen tasks run with independent agents, one per repository, no musterd. Scores and token cost recorded. |
| 5 | The team run, and the write-up | `docs/wiki/wideswe.md` | The same tasks run on revive. The result goes in the wiki, win or lose, with the baseline beside it and the cost of each. |
