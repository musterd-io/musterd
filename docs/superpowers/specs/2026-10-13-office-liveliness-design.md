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

- **Deliver carrier is learned, not told.** The room learns a lane's owner from the claim and pin walks
  it plays. A lane claimed before the viewer opened the page, outside the replay window, still carries
  as the ask's sender. The complete fix is an `owner` field on `meta.lane_review` — a protocol change,
  so it needs an ADR (`AGENTS.md` hard rule 1). Not proposed here.
- **Replay is bounded by the history fetch.** `/live` backfills the newest 200 envelopes
  (`fetchHistory`, `limit: 200`); replay can only play what is inside that. A quiet team has ten minutes
  inside it; a very busy one may not.
- **Replay's tempo and cap are checked by eye.** The foreground check on 2026-10-13 saw the room fill by
  ~4 s and walks reach the board and a desk. It did not time the 2× or count to eight. There is no
  automated check of either (the unit tests cover the selection in `replay.ts`, not the playback).
- **Acceptance is inferred, not told.** The resolve carries no flag, so the room calls a done pin an
  acceptance when the resolver is not the owner it saw claim or submit. A lane it never saw owned counts
  as accepted, and a self-close of such a lane puffs too.
- **A viewer who is the sender sees nothing live from another machine.** Separate from the room, and
  filed as `01M4V95YGT` (a human's hub-origin accepts never reach their own joiner tab).

## 6. What is still to build

nick liked these when they were listed (recorded in this seat's 2026-10-13 handoff note). None is approved, and each has its own lane (ADR 487) so none can vanish into this document; each has a bar so it can be
accepted or rejected, and a falsifier. Every one that adds bytes pays against ADR 151's budgets, and
`docs/perf/web-live-baseline.md` is where the cost is logged.

| # | Lane | Beat | What the viewer sees | Bar | Falsifier |
| --- | --- | --- | --- | --- | --- |
| L1 | `01M4V9VNMYRCDW59NF9B2NX69T` | **More frequent desk micro-loops** | a seated member does small things between acts — a sip, a glance at a neighbour, a stretch — often enough that no desk is frozen for a minute | across ten minutes of a quiet team, every seated member plays at least one gesture, and no ambient beat plays twice in a row for the same member | the draw is already uniform and the room still reads as still: then the lever is the gesture set, not the rate |
| L2 | `01M4V9VQC8QG9KPEEEDJWCFZ40` | **Errands and the pet** | the pet follows an errand; a member who gets up for water or lunch is sometimes joined | one new pet-and-member interaction, seeded, that two viewers see identically | two viewers of the same team see different pet positions at the same slot |
| L3 | `01M4V9VSAMHYRVBDMG0RK6248Q` | **Accept celebration at the board** | the acceptor walks to the wall, the card gets a small flourish as it moves to done | the acceptor's walk and the owner's pin do not collide, and the celebration plays once per accept | a lane accepted with the acceptor out of the room plays nothing and loses the cue |
| L4 | `01M4V9VTX0Y84C5M7TQH2M2K9F` | **Lamp and window light** | the room's light follows the hour — a lamp comes on at dusk, a window warms | one light change across a day, drawn on the canvas, not in CSS | initial-JS headroom is under the cost; then it waits for the budget |
| L5 | `01M4V9VWN914VH186VMMKXRR38` | **Micro-polish** | the card wobbles as it is pinned, pin holes stay, a nameplate sits a degree off, a door opens a crack as someone arrives | each is one visible change at true stage size, checked against the ten slop tells | any of them reads as decoration (tell 3: a pulse that never turns off) |
| L6 | `01M4V754ZD` | **A stalled goal is visible in the room** | miley's lane — listed so the two do not collide on `office-scene/**` | — | — |

L1–L5 were opened `open` on 2026-10-13: parking is a human's call (ADR 466), so until nick parks or
claims them `team_next` offers them. That is the cost of not being approved yet, and the reason to answer
the ordering question in §9 soon.

Ordering: L3 first (it completes a promise already made), then L1 (cheapest, and the room's baseline
liveliness), L5 as small independent lanes, L2 and L4 last because they move bytes.

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

1. Is ten minutes / eight walks the right replay sample? A team that opens `/live` after an hour away
   sees a still room by design. Say if that should change; it is one constant.
2. Should the carrier fix go all the way to an `owner` on `meta.lane_review` (an ADR), or is "the room
   learns it from what it watched" good enough given the edge in §5?
3. L3 before L1, as ordered above?
