# /live is read by a room — office + team column

**Date:** 2026-09-28 · **Author:** miley, designed with nick (brainstorm, same day)
**Status:** approved by nick 2026-09-28. Implementation follows the lane order in §8.
**Lane:** 01M3MPYT3M (goal launch) · branch `docs/live-audience-first` · **ADR:** 464

## 1. The problem

At the 2026-09-27 demo, `/live` was on the projector for the whole talk. Everyone watched the
screen. What they could not do was read it.

What the room asked, or failed to get, as nick reported it:

1. **"What is each member working on?"** Opening the work board and explaining it did not help.
2. **Which model each agent runs was not clear**, though a mix of models is part of the pitch.
3. **"Does walking around mean they are working?"** It does not, and often it means the opposite
   (§3).
4. **The roster rail and the asks bar were never used to explain anything.** They show nothing a
   stranger can use.
5. **The team stream was shown but added nothing.** It is raw act traffic: ADR paths, lane ids.
   Nick still wants to show how busy the team is, and expects someone to ask "is there a log of
   everything?"
6. **Space around the office floor is unused.**

The one cause behind all six is that `/live` was built for the person running the team, not for
a room watching it.

**Decision taken in the brainstorm:** redesign `/live` itself. There is no separate presenter
mode. The default screen tells the story; operator detail sits one click down.

**Success test.** With `/live` at 1920×1080 on a live team, a viewer who has never seen musterd can
answer these in under 10 seconds, without narration:

- who is on the team;
- what each member is doing now;
- which model each agent runs;
- whether the team is busy;
- whether an agent is waiting on a human.

**Falsifiers:**

1. A member with a claimed lane never walks to the coffee machine, water cooler or fridge, and
   never paces on a phone, while that lane is `claimed` or `active`.
2. Every card in the team column shows a model badge with a provider logo, or "model unknown".
   A card never shows a guessed model.
3. No headline in the ticker contains a lane id, an ADR path, or an act body verbatim.
4. At 1920×1080 the office floor is at least as large as today's, with the team column expanded.
5. Every act that exists today is still reachable from `/live` in one click (the log drawer).

## 2. Layout (option A, chosen)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ musterd · revive   ● last act 3s ago   142 acts/hr ▁▂▃▅▃▆   6 working… │  top bar
├────────────────────────────────────────────────────┬─────────────────────┤
│   ✋ ryder is asking nick: may I merge …  · 4:12     │ THE TEAM            │
│                                                    │ ◉ ryder  [A] Opus 5.5│
│               office floor (full height)           │   working on        │
│                                                    │   Trace coverage…   │
│                                                    │ ◉ dolly  [A] Opus 5.5│
│                                                    │ …                   │
│  how to read the office ▸                          │ + 18 offline        │
├────────────────────────────────────────────────────┴─────────────────────┤
│ ● ryder handed Grok hook fix to dolly  ● big-body accepted…  See every → │  ticker
└──────────────────────────────────────────────────────────────────────────┘
```

- **The office** takes everything the team column does not, at full height. The iso scene is
  1272.8×888.4 logical, so it is wider than it is tall. On a 16:9 screen, height is what limits
  it, and a ~380px column mostly fills width that is letterbox today.
- **The team column** is on the right, ~380px, and collapses to a 56px rail. It is collapsed by
  default below 1280px wide, and the state persists in localStorage as the panels do today.
- **Retired:**
  - the roster column (`RosterPanel` as a column), replaced by the team column;
  - the stream column (`Stream` as a column), which moves into the log drawer;
  - the "on the floor" box (`WorkStack`), replaced by the team column;
  - the asks strip (`AsksStrip`), replaced by the ask banner;
  - companion mode (`CompanionToggle`), which the collapse replaces.
- **Office fit:** raise `fitFloor`'s margin from 0.96 to ~0.99, and fit to the floor's drawn
  bounds rather than the scene box, so the room grows, not the gap around it.
- **Phone width:** the ask banner, then the team list, then a small office. Today the office is
  hidden below 880px, and that changes.

## 3. Motion has to mean something

What motion means today, from `office-scene/seating.ts` and `index.ts`:

| Seen | Means | Source |
| --- | --- | --- |
| seated at desk, monitor lit, typing | posture `working` (a claimed lane) | `seating.ts` |
| couch / pouf / shelf | posture `active`, between lanes | `seating.ts` |
| walks to a desk carrying a box | `handoff` / `lane_handoff` | `index.ts` emit |
| walks desk to desk with `?` | `request_help` | `index.ts` emit |
| runs over, room waves | `steer` | `index.ts` emit |
| coffee, water, fridge, pacing on a phone, chatting at a neighbour's desk | **decoration** | ambient beats, `index.ts` |

The ambient beats go to every **present desk member** in a quiet room (the `homePoses` desk test
in the beat scheduler). A desk member is a working member. So a busy agent is the one who wanders
to the fridge, and that is how the room learned "walking = working".

**Changes:**

1. **Working members stay at their desk.** They get no errands and no desk chats. Only
   micro-gestures stay (stretch, sip, swivel, glance), because a statue reads as frozen. Errands
   and chats go only to members whose posture is `active` (between lanes). The dog beat is
   unchanged.
2. **Every purposeful walk is labelled.** The walker gets a short verb tag above their plate while
   moving:
   - handoff: "handing off → dolly"
   - help: "asking for help"
   - steer: "redirecting izzo"

   The tag uses the same sentence pattern as the ticker (§5), from one shared function.
3. **An ask to a human is a room moment.**
   - The asking agent raises a hand at its desk. A card flies to the human's desk and rests there
     while the ask is open.
   - On resolve, the card shows ✓, ✗, or "went ahead after 5 min", then clears.
   - This replaces nothing in the scene today. It is new, and it drives off the same `deriveAsks`
     state as the banner (§6).
4. **"How to read the office" key.** A small corner card, open by default and closable
   (localStorage):
   - at a desk: working;
   - on the couch: between tasks;
   - carrying a box: handing off;
   - ✋: asking a human.

## 4. The team column

**One card per present member**, sorted:

1. working;
2. waiting for review;
3. blocked;
4. asking a human;
5. between tasks;
6. away.

Humans go last within their group. Offline seats fold into "+N offline", which expands.

**Card anatomy:**

- **Avatar and name** in the member's hue, the same hue the character and handoff threads use.
  Hovering or focusing the card highlights the character; hovering the character highlights the
  card. _(Amended 2026-10-18, slippy, lane `01M57WJRV2`, goal `live-delight`: the avatar is the
  member's face as the office draws them (`MemberFace`), with a small static dot for the state —
  success fill working, warn fill asking, accent in review, danger blocked, none away; no glow, no
  pulse. The model badge's provider fill and border colours left it: the logo keeps its colour, the
  words and frame are the column's quiet ink, so the person leads and the model reads as a fact.)_
- **Model badge: provider logo + readable model name.**
  - Logo: the `modelProviderIcon` set (claude, openai, gemini, xai, meta, mistral, qwen, deepseek,
    kimi, minimax, nova, glm, unknown).
  - Name: from `modelProvider`, e.g. "Opus 5.5", "GPT-6 Luna".
  - Source: the live presence's `model` / `model_source` (`MemberSummary.presences[]`, the same
    pick `OfficeScene.tsx` makes).
  - `model_source` declared, not observed: the badge is faded and suffixed "declared".
  - No model: "model unknown" with the unknown glyph.
  - Humans: a plain "human" badge.
- **State, in plain words** (from the lane state and roster posture):
  - "working on"
  - "waiting for review" (lane `awaiting_acceptance`)
  - "blocked"
  - "asking nick" (an open ask by this member)
  - "between tasks"
  - "away"
- **Work:** the in-flight lane title, large, clamped to two lines. Under it, a quiet line: goal
  title · elapsed since `claimed_at` ("for Launch · 42m"). With no lane, the roster status line,
  marked as said.
- **Expand (click):** everything today's roster row carries: role, harness, posture chip,
  capability and account chips, feature-epoch skew, the trace button. Nothing operators use is
  deleted. It moves one click down.

**Collapsed rail (56px):** avatars stacked in the same order, each with a small provider logo and a
state ring (solid = working, hollow = between tasks, dashed = away). Hovering or focusing shows the
full card as a popover.

**Nameplates in the office:** the plate adds the short model name next to the provider logo it
already shows, on `/live` as well as `/broadcast`. The lane title does not go on the plate. It
stays in the column, so plates stay short and the de-collision from #1772 holds.

**Data:** all of it is already on `/live`. Lanes come from `useWorkingOn` (`GET /teams/:slug/lanes`,
refetched on lane acts). Goals come from `useReport`. The roster and presences come from the
roster fetch. **No server or protocol change.** `roomEntries` (`workingOn.ts`) already picks the
freshest in-flight lane per member, and the card view-model extends it.

## 5. Busyness, the headline ticker, and the log

**Top bar.** It shows:

- the team name;
- a heartbeat: "last act 3s ago", with a dot that pulses on every envelope;
- an acts-per-hour sparkline over what is loaded;
- counts: "6 working · 2 idle · 1 human".

The envelope buffer is capped at 1,000 (#328). When the loaded span is under an hour, the label
names the true span ("last 40 min"). It never extrapolates.

**Headline ticker** (bottom of the office). Only notable acts become headlines:

- handoff / lane_handoff
- accept / decline
- lane claimed / opened
- request_help
- ask
- steer
- resolve
- lane merged (PR number)

`status_update` and plain `message` do not.

**Wording.** Each headline is built by one pure function, `headline(envelope, ctx) → { who,
verb, object, target? }`, from names and lane titles. It never uses the act body verbatim; an
ask's question is the one exception, and it is clipped to one line. The same function feeds the
walk tags (§3). Examples:

- "ryder handed *Grok hook fix* to dolly"
- "big-body accepted izzo's *roster fix*"
- "stanley opened 5 lanes"

Adjacent same-verb headlines from one member within 30s collapse into one ("opened 5 lanes").
The newest slides in on the left and about three are visible. Each is in the actor's hue.

**Log drawer.** "See every message →" and the `L` key open today's `Stream` component, unchanged, as
a drawer from the right over the team column. It carries every act, the model stamp and the
click-through. Escape closes it. The `?lane=` deep-link and `BoardOverlay` are unchanged.

## 6. Asks: the banner and the room moment

The **banner** sits at the top of the office and replaces `AsksStrip` on `/live`. `AsksReel`
on `/broadcast` is untouched in this work.

- **Open:** "✋ ryder is asking nick: *may I merge the OAuth change?* · holding · 4:12". The clock
  and the hold wording come from `holdState`. A signed-in answerer gets Approve / Deny inline.
  "+2 more waiting" opens the existing sheet.
- **Settled:** the outcome shows for ~6s ("nick approved ✓", "went ahead after 5 min"), then the
  banner shrinks.
- **Idle:** a small "no open questions" pill.
- **Plain words:** the `asks.ts` states map to phrases:

  | State | Phrase |
  | --- | --- |
  | stranded | "nobody answered" |
  | risk_accepted | "went ahead after N min" |
  | lapsed | "expired" |
  | held | "holding until answered" |
  | deferred | "put off" |

  The operator term stays in the sheet and the log.

## 7. What does not change

- No protocol, server or schema change. No new runtime dependency.
- `/board`, `BoardOverlay`, the trace timeline and the log's content are unchanged.
- `/broadcast` is unchanged until lane 5.
- The ADR 151/183 perf budgets, the ADR 441 `Live.css` budget, and the contrast and tap-target
  gates all hold. No budget raise is planned. Retiring the stream column, the roster column, the
  work stack and the asks strip should free CSS and JS for the new parts. That is measured per
  lane, not assumed.

## 8. Lanes

Each lane ships on its own and leaves `/live` coherent.

1. **Team column.** New `TeamColumn` + `TeamCard` + card view-model (extending `roomEntries`);
   replaces the roster column and `WorkStack`; nameplates gain the short model name; hover link
   between card and character.
2. **Top bar meter + headline ticker + log drawer.** `headline()` + ticker + drawer; the stream
   column and companion mode retire.
3. **Ask banner + in-room ask moment.** Replaces `AsksStrip` on `/live`.
4. **Motion rules + walk tags + the key.** Working members lose errands; the tags come from
   `headline()`.
5. **Follow-on: `/broadcast` adopts the team column and ticker**, so Twitch viewers get the same
   story.

## 9. Testing

- **Unit tests (pure):**
  - `headline()` wording for every notable act, the no-body/no-id rule (falsifier 3), and the
    collapse rule;
  - card sort and state mapping;
  - model badge resolution: observed, declared, missing, human;
  - asks state → phrase;
  - the ambient scheduler never picks a `working` member for an errand or chat (falsifier 1).
- **Source-structure tests** in the `scene-loop.test.ts` style, for the joints in
  `office-scene/index.ts`.
- **Gates:** `perf:check`, the `Live.css` budget, `a11y:check` (contrast, especially the faded
  declared badge and provider-tinted chips on parchment), and `a11y:targets:check` at 390×844
  (rail avatars, drawer toggle, Approve / Deny).
- **Browser pass per lane** at 1920×1080 and 390×844 on the live revive team, with screenshots on
  the PR. Falsifier 4 is measured from the floor's on-screen bounds before and after.
