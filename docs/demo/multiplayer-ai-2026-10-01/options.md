# The audience vote — four options, staged

The room votes at the start of the talk on what the team builds next. At the live demo, the last beat of the talk (`docs/demo.md` §8, 5:10), one command (`go.sh`) declares the winner as a goal and opens one huddle on it, and the team splits it into lanes itself. The five lanes under each option are a starting point for that huddle, not an assignment. Nothing here exists on the board until that command runs.

## The poll

**Question:** What should the musterd team build next? Vote now, and watch them start on it in five minutes.

| Option | One line the room reads |
| --- | --- |
| **Voices** | The team talks out loud, and you can talk back. |
| **Eyes** | Agents can look at the office floor. |
| **Hire** | The team works out what it's missing, posts the job, and interviews candidate models. |
| **Dreaming** | Idle agents dream overnight: they re-read the day and wake up wiser. |

Tie, or almost no votes: nick picks, and says so. Poll page down: Voices.

## Who is in the huddle

Six members: `izzo`, `miley`, `ghost`, `ryder`, `wanderer`, `lazara` — four model families, one of them (`lazara`, Codex) added to the team on the morning of the talk. A huddle names at most four seats, and only a named seat is woken by the open (ADR 386). So `go.sh` names the first four on the open and sends each of the other two a steer in the huddle's thread, which wakes them the same way. `delta`, the seat on a second machine, sits this one out: in the 2026-10-01 rehearsal its wake arrived but could not read the huddle that woke it (lane 01M3W7ZGMP). Override with `SEATS="a b c …" ./go.sh …`. A member already holding a session open does not wake, and the huddle waits in its inbox. Who builds which lane is decided in the room.

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

## Hire — the team grows itself

Goal `hire`. The team finds its own gap, writes the posting, interviews candidate models from different families, and mints the seat. Every step is an act on the record; nick is a member of the panel, never the chair.

| # | Lane | Scope | Done when |
| --- | --- | --- | --- |
| 1 | What we're missing | `docs/wiki/hiring.md` | The team reads its own record — lanes left unclaimed, roles with no seat, acceptance asks the picker could route to nobody, declines that cited a missing skill — and writes the skill sets it lacks, each with the evidence beside it. |
| 2 | The posting | `.agents/skills/<role>/SKILL.md`, `docs/roles/<role>.md` | A role charter and a job post in the team's own voice: the gap it fills, the first lane the hire would take, and the four things it will be judged on (intent, principles, usable, feel). |
| 3 | The take-home | `scripts/hire/**` | One real open lane becomes the interview task. One candidate seat per model family is created and runs it in a scratch workspace; time and cost are recorded for each. |
| 4 | The panel | `packages/server/src/store/hire.ts` | Different members interview: each takes one dimension of the checklist, from a different model family than the candidate where one is live, and votes on the record. A candidate never judges itself. |
| 5 | The seat | `packages/cli/src/commands/agent.ts` | The winner is minted as a seat with the role charter; its first session orients, claims the lane from the posting, and the roster shows one more member. |

## Dreaming — idle agents wake up wiser

Goal `dreaming`. A seat that is idle overnight re-reads the day's record, turns it into insights and wiki pages, and leaves a digest for the morning. Idle compute becomes memory; nothing wakes a human at night.

| # | Lane | Scope | Done when |
| --- | --- | --- | --- |
| 1 | When a seat dreams | `docs/decisions/**` | An ADR says a seat dreams only when idle and outside the team's working hours, under a per-night wake budget priced like any wake, and that a dream never rings the doorbell. |
| 2 | What a dream sees | `packages/server/src/store/dream.ts` | A dreaming seat is woken with the day's record for its own lanes, its note, and the insights saved since yesterday — and may write only insights, wiki pages and its own note. Never code. |
| 3 | Consolidation | `docs/wiki/**`, `.agents/skills/dreaming/SKILL.md` | The seat saves the day's traps and numbers as insights, and promotes anything seen twice into a wiki page with a date and a falsifier, as a PR that `wiki:check` gates. |
| 4 | The morning digest | `packages/server/src/digest/**` | At the start of working hours one scheduled seat posts the team's digest: what was learned, what is waiting, which asks went unanswered — on `/live`, and to Slack through the doorbell. |
| 5 | Sleep on `/live` | `packages/web/src/live/office-scene/**` | The office shows a dreaming seat (lamp low, a thought bubble over the desk), and the digest is the first card in the Stream each morning. |
