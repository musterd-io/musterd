# Office liveliness — the choreography grammar, and what is still to build

**Date:** 2026-10-13
**Seat:** slippy
**Status:** describes what shipped 2026-10-09 → 2026-10-13 (lanes under goal `office-liveliness`); the
"still to build" list (§6) is proposed, not approved.
**Lane:** `01M4V74820`

## 1. What this is for

The goal `office-liveliness` reads: *open /live and the room is moving — members fetch cards from the
board, hand them over, pin them done, and fidget in between.* Five beats shipped against it in four
days, each from a sentence of nick's, each in its own lane. They share a grammar that lives in code
comments and in one row of `docs/architecture/08-web.md`. Nothing says what the grammar **is**, so the
next beat is built by copying the last one and the invariants are rediscovered by breaking them
(replay played inside `update()` and was reverted once, #2429 → #2445; the deliver walk took its
carrier from the wrong member until sloane read the diff, #2471).

This spec writes the grammar down so a later beat has a home. It adds no behaviour. Where a claim here
and the code disagree, the code is right and this document has a bug.

## 2. The model in one paragraph

A lane's life is a card. `/live` already receives every act; `actToEvent` (`mapping.ts`) is a **pure**
projection from an envelope to an `OfficeEvent`, and the scene (`index.ts`, the `emit` switch) decides
how to render it. A walk is a real act: it preempts ambient filler, queues behind other act walks, and
is capped. The wall board is the lane board squinted at from across the room: a card is a **seed**
(`laneSeed(lane id)`), and its place is a column. Walks move seeds; board data catches up a beat later.
Everything the room does with nobody acting — fidgets, errands, the pet, the aisle meet — is a pure
function of `team + 10 s slot + purpose` (`ambientSeed.ts`), so every viewer of a team sees the same
idle life, and a real act always wins.

## 3. The beats

| Beat | Trigger (envelope) | Who walks, to where | The card | If it cannot play | Code |
| --- | --- | --- | --- | --- | --- |
| **claim** `walk-claim` | `lane_claim` (`meta.lane_claim.lane`) | claimer → wall board, stands and thinks, reaches up, takes the card, carries it home, sets it down. nick 2026-10-09. | slot goes empty (`taken`), paper leaves with the walker | blue in-place cue | `actors.claim`, `buildClaim` |
| **pin** `walk-pin` | `lane_resolve` / `lane_state` with state `done` or `awaiting_acceptance` | whoever resolves or submits the lane picks the card up at their desk, carries it to the board, pins it under its new column — the owner on a submit, the **acceptor** on a done (the daemon sends the resolve as them). nick 2026-10-12. | wall shows the card pinned before the board data does (`pinnedSeeds`); an acceptance's done pin puffs confetti over the done column as it lands (L3, shipped) | green ✓ cue, plus the puff at once; an abandon keeps the in-place ✓ (nothing was finished) | `actors.pin`, `buildPin` |
| **deliver** `walk-deliver` | `ask` to a member carrying `meta.lane_review` (the acceptance ask, ADR 192) | the **lane owner** carries the card to the acceptor's desk and hands it over. Replaces that submit's pin. nick 2026-10-12. | off the cork until it changes hands (`takenSeeds`) | the already-queued pin stands; only a thread is drawn | `actors.deliver`, `buildDeliver`, `laneOwners.ts` |
| **handoff** `walk-handoff` | `lane_handoff`, or a `handoff` act to a member | sender → recipient's desk, with a short label | none | team megaphone if the act has no named recipient | `actors.walk` |
| **aisle meet** (ambient) | none — scheduled | two idle members get up, meet between their desks, talk a few seconds, go back. nick 2026-10-12. | none | the slot passes | `actors.aisleMeet`, `decideAmbient` |
| **replay** | `/live` mounts | the last ten minutes' claim / pin / handoff / deliver walks play once, oldest first | as above | none — it is a sample | `replay.ts`, `OfficeHandle.replay` |

Other acts keep their older choreography (screen pulse, note, help walk, megaphone, steer sweep,
challenge cue, defer, the accept's confetti over the **celebrant's** desk). `actToEvent` returning
`null` means *not animated*.

## 4. The invariants

These are what a new beat must keep. Each has bitten once.

1. **The mapping is pure; the scene renders.** `actToEvent` reads one envelope and returns data. It
   cannot know who owns a lane, who is in the room, or what is on the board. Anything that needs that
   state belongs in the scene — which is why the deliver carrier is remembered by `laneOwners.ts` and
   not looked up in the mapping. (`meta.lane_review` carries no owner, and the sender of a re-routed ask
   is whoever re-routed it, ADR 545.)
2. **A real act never waits behind filler.** `claim`, `pin`, `deliver` and `walk` each preempt an
   ambient or yielding walk from where the walker stands, then queue behind other act walks, **at most
   three pending per walker**; the fourth returns `false`.
3. **A beat that cannot play degrades to a cue, never to nothing.** The mover or the target being out of
   the room, or the target being `dnd`, returns `false`; the scene then draws the in-place cue or the
   thread. A viewer must still be able to tell that something happened.
4. **A card is a seed, and the room runs ahead of the data.** The walk pins or takes a seed immediately;
   the wall is painted from the board *plus* the in-flight walks (`wallBoardNow()`), so a card in
   someone's hand leaves its slot empty and a pinned one shows before the lane board refetches.
5. **Replay plays walks only.** Speech, captions, cues and the asks' hands stay live-only — a replayed
   bubble would say a nine-minute-old sentence as if it were now. Events that already arrived live are
   skipped (`liveIds`). Window `REPLAY_WINDOW_MS` = 10 min, at most `REPLAY_MAX` = 8, at `REPLAY_TEMPO` = 2×
   (4× made a board trip about 2 s and nick missed it). It is **drained by the frame loop, never inside
   `update`** — the first attempt ran inside `update` before the frame was built and a mount `catch`
   swallowed the throw.
6. **Ambient is shared and polite.** One beat at a time. Every ambient decision is a pure function of
   `team + slot + purpose`, so viewers converge; a slot that lands mid-errand or in a hidden tab simply
   passes. Ambient fires only into a calm, visible, non-reduced-motion room (`!reduced && !suspended &&
   VISIBLE() && quiet()`), and a real act cancels it (`cancelAmbient`).
7. **Motion must stop when unseen.** The rAF loop suspends when the panel is collapsed or the tab is
   hidden (#331). A backgrounded tab parks the loop, which is why a headless or background-tab repro of
   replay is inconclusive — check in a foreground window.

## 5. Known edges (true today)

- ~~**Deliver carrier is learned, not told.**~~ _Fixed 2026-10-15 (lane `01M50TZDDM`), without a
  protocol change:_ the room reads each lane's `owner_seat` from the board `/live` already holds, as the
  base layer under the walks it watches. A board refresh replaces what the room watched before it; a
  walk watched after the refresh wins until the next one, since the board has not caught up; a replayed
  walk never sets an owner. Remaining edge: an ask for a lane the board does not list, which the room
  also never saw owned, still carries as the ask's sender. An `owner` on `meta.lane_review` would close
  it and is still not proposed.
- **Replay is bounded by the history fetch.** `/live` backfills the newest 200 envelopes
  (`fetchHistory`, `limit: 200`); replay can only play what is inside that. A quiet team has ten minutes
  inside it; a very busy one may not.
- ~~**Replay's tempo and cap are checked by eye.**~~ _Checked 2026-10-15 (lane `01M50TZA8X`):_
  `actors.test.ts` times a claim walk at `REPLAY_TEMPO` against the live walk (half the frames, within
  5%), `replay.test.ts` already counted the cap of eight, and `scene-loop.test.ts` pins that the drain
  sets the tempo. The playback in a real browser is still checked by eye.
- **A replayed walk wears its age** (nick, 2026-10-15, lane `01M50TZA8X`). The walk tag reads
  "claiming X · 4m ago" ("just now" under a minute), so a viewer does not read a nine-minute-old claim
  as happening now. On a long verb the verb ellipsizes and the age stays whole. The window stays ten
  minutes; nick considered 30 and kept 10. `/office-preview?replay=1` shows it without a daemon.
- **Acceptance is inferred, not told.** The resolve carries no flag, so the room calls a done pin an
  acceptance when the resolver is not the lane's owner. Since 2026-10-15 (lane `01M50TZDDM`) the owner
  comes from the board as well as the walks, so a self-close of a lane claimed before the viewer arrived
  no longer puffs. A lane neither the board nor the room has an owner for still counts as accepted.
- **A viewer who is the sender sees nothing live from another machine.** Separate from the room, and
  filed as `01M4V95YGT` (a human's hub-origin accepts never reach their own joiner tab).

## 6. What is still to build

nick liked these when they were listed (recorded in this seat's 2026-10-13 handoff note). None is approved, and each has its own lane (ADR 487) so none can vanish into this document; each has a bar so it can be
accepted or rejected, and a falsifier. Every one that adds bytes pays against ADR 151's budgets, and
`docs/perf/web-live-baseline.md` is where the cost is logged.

| # | Lane | Beat | What the viewer sees | Bar | Falsifier |
| --- | --- | --- | --- | --- | --- |
| L1 | `01M4V9VNMYRCDW59NF9B2NX69T` | **Fair desk micro-loops** (shipped: who fidgets is a rotation, not a draw) | a seated member does small things between acts, and no desk sits frozen while a neighbour fidgets twice | **Bar, restated by nick 2026-10-13 (option 2):** in ten minutes of a quiet team, at most 15% of a six-person room and 20% of a twelve-person room have no single-member beat; a lap is a permutation and never repeats a member back to back. Measured with the room-quiet gate: 9% at six, 15% at twelve (a uniform draw: 22% and 35%) | The original bar, every seated member in ten minutes, **cannot be met at twelve**: ADR 086 holds one beat at a time, so about ten single-member beats land in ten minutes. Reaching it would take a density decision (cut the dog's 35% share of beats, or let in-place gestures play beside another beat, which is an ADR 086 change). Not taken. _2026-10-15 (nick, lane `01M50X1WRW`):_ the bar nick chose instead is that **every occupied desk shows motion at all times**, met within ADR 086 Tier A. A desk the hash gave neither a fan nor a mug now gets one of the two (`deskHasProp`, on its own hash, so the room still varies: 6 fans and 12 mugs across 17 desks), and the desk steam runs out of phase from mug to mug. The seated person still holds still between beats; moving the people more is the ADR 086 change above. _Taken 2026-10-15 ([ADR 617](../../decisions/617-companion-gesture.md), lane `01M50YPZN8`):_ in a room of six or more, a fired slot can carry one companion's in-place beat (0.9 beside a mover, 0.4 beside a still beat), and a companion near something moving swivels to watch it go by. The model leaves 0.25% of a twelve-person room still for ten minutes |
| L2 | `01M4V9VQC8QG9KPEEEDJWCFZ40` | **Errands and the pet** (shipped: the dog tags along on a water errand) | the dog sometimes trots to the cooler with a member filling a bottle and sits with them, as it already does for coffee and begs at lunch | one new pet-and-member interaction, seeded on the shared slot so two viewers see the same trip; the destination is walkable and the dog ends within 70 units of it | two viewers of the same team see different pet positions at the same slot — not observed; the roll is `roll(team, slot, 'pet-follow-water')` and nothing local feeds it |
| L3 | `01M4V9VSAMHYRVBDMG0RK6248Q` | **Accept celebration at the board** (shipped: the flourish at the pin) | the acceptor already carries the card to the board (the daemon sends the resolve as them); a puff of paper now lifts over the done column as it lands — at once if the acceptor is not in the room, never during a replay | the flourish plays once per accept and never collides with the pin (only the resolver walks) | a lane accepted with the acceptor out of the room plays nothing and loses the cue — not so: the fallback puffs at once |
| L4 | `01M4V9VTX0Y84C5M7TQH2M2K9F` | **Lamp and window light** (**already built; lane closed**) | desk lamps come on at dusk over an occupied desk, the sky wash warms at dawn and dusk, window glass tints with the sky and goes dark with a faint city at night | `lighting.ts` (`lampsOn`, `daylight`, warmth) and the night veil; a 1280×720 capture of the preview at `?light=19` shows lamp pools and dark panes | this entry was wrong: the beat was written down from a remembered idea, not checked against `lighting.ts`. A genuinely new light (sun shafts on the floor at golden hour) would be its own lane; **follow-up shipped (lane `01M4VR902N`):** the window shafts did not move — `BEAM_LEN`/`BEAM_SHEAR` were constants — so they now follow the sun (`sunBeam(hours)`: long and leaning at dawn and dusk, short and straight at noon, flipping sides), and the motes and the dog's sunbeam nap spots take the same geometry |
| L5 | `01M4V9VWN914VH186VMMKXRR38` | **Micro-polish** (shipped: four touches) | a card that lands swings on its tape (two swings over ~1 s; the first cut peaked at ~1 px at 1280 wide and could not be seen, now ~2.7 px); every slot a card has hung in keeps a tack hole once it is empty (a per-viewer high-water mark in browser storage); nameplates sit a seeded ±0.8° off true; the door parts a crack of light on arrival | each is one visible change at true stage size; the hole and the nameplate tilt checked in captures at 1280×720 (the hole is a dark speck in a column with a free slot) | "pin holes stay" was first met as viewer-local history (each browser remembered the most cards it had seen in a column, so viewers saw different corks). _Since 2026-10-15 (lane `01M50WEBTC`, nick chose "derive them from the board"):_ the holes are derived from the board: per column, the cards there now plus lanes updated in the last 7 days that have moved past it, capped at the column's slots. Every viewer sees the same cork, and browser storage is no longer used. Blocked counts only lanes blocked now, since the board does not record which lanes were blocked before. (big-body declined the first cut, holes only while a card is in hand; #2506 then showed a hole in every empty slot; this lane replaced that with history) |
| L6 | `01M4V754ZD` | **A stalled goal is visible in the room** | miley's lane — listed so the two do not collide on `office-scene/**` | — | — |

L1–L5 were opened `open` on 2026-10-13: parking is a human's call (ADR 466), so until nick parks or
claims them `team_next` offers them. That is the cost of not being approved yet, and the reason to answer
the ordering question in §9 soon.

Order built: L3, L1, L5, L2. L4 turned out to exist already (above). Total JS is within ~0.8 KB of its
ceiling, so a further beat that moves bytes needs a measured ADR 183 raise or a trim first.

## 7. Adding a beat — the checklist

1. `types.ts`: a new `OfficeEvent` kind, and if it is a walk, add it to `ReplayEvent` and `REPLAYED`
   in `replay.ts` **only if** it is a lane walk (invariant 5).
2. `mapping.ts`: a `case` in `actToEvent`. Pure. Read only the envelope.
3. `actors.ts`: a builder, an `Actors` method with the preempt-then-queue shape and the cap of three,
   and `false` for every way it cannot play.
4. `index.ts`: the `emit` case — the walk, its `walkTag` verb, **and the fallback cue** (invariant 3).
   If it needs state about a lane or a member, hold it in the scene (invariant 1).
5. Tests: a mapping case, an actors case (preempts ambient; capped; false when absent), a scene-loop
   assertion that the case calls the walk and keeps the fallback.
6. `docs/architecture/08-web.md`: the Choreography row and a described line in the file tree
   (`pnpm arch-trees:check` enforces the file set).
7. Capture at true stage size in a **foreground** window, both themes, reduced motion; run `pnpm
   perf:check` if bytes moved. Attach the capture to the acceptance ask.

## 8. Non-goals

- No protocol or server change. Every beat is derived from acts `/live` already receives.
- No replay of speech, captions or cues (invariant 5).
- No sound in this spec — sound has its own spec (`2026-07-30-office-life-motion-sound-design.md`).
- No attempt to make the room a faithful log. It is a sample that says *this team is working*; the
  stream beside it is the record.

## 9. Open questions

1. ~~Is ten minutes / eight walks the right replay sample?~~ Answered 2026-10-15 (nick): keep ten
   minutes and eight walks, and label each replayed walk with its age (§5).
2. ~~Should the carrier fix go all the way to an `owner` on `meta.lane_review` (an ADR)?~~ Answered
   2026-10-15 (nick): no. The board's `owner_seat` covers it without a protocol change (§5).
3. L3 before L1, as ordered above?
