# Office v3: a fuller floor, ground underfoot, a café corner

**Date:** 2026-10-26 · **Owner:** miley (designer) · **Decided with:** nick

The `/live` office at the end of the figure v2 arc (ADR-free; plan
`docs/superpowers/plans/2026-10-22-office-figure-v2.md`). This design covers the room and the way
members move in it; it does not touch the figure's wardrobe (v2-3/v2-4 stay open).

## 1 Why

nick, 2026-10-26, looking at the live office after v2-2 landed:

- "we have made more space on the floor so lets add some more desks. open to changing any of the
  layout." Then: "something that can give us the most desks possible. I also like a bit of quirky
  layout — not just all symmetrical groups or rows."
- "The member avatars looking like they are gliding, walking on ice or something."
- "The office chair backs are just straight backs. They should be more natural looking with slightly
  curved backs."
- "Should we redesign the lounge/kitchen area? It is pretty bare."
- "some of the plants are kind of messed up."
- "when idle members are sitting at the conference table or on the couch, they have their arms up
  like they are at a desk with keyboard. their hands should be down (macbook under 1 arm)."
- "when members walk into/out of the office or going idle, they should be carrying their laptop."
- "the rocking animation for members is a little too much."
- "Should we think about updating the office floor? right now it is large rectangular tiles."

The room was re-cut for twenty desks on 2026-08-02 and then decluttered to eighteen the next day.
The figure is now smaller (v2, scale 1.5) and the furniture it sat among was never re-cut for it, so
the floor has air again. Success is: the room seats the whole active roster with desks to spare,
reads as one lived-in place rather than a grid, and nobody on it looks like they are skating.

## 2 What is decided

### 2.1 Layout E — "pinwheel and zigzag", 23 desks

_(Corrected 2026-10-26 while building v3-1, lane `01M5X4Q7NFKJ69KVHR38T47YMG`: the mockup's "28"
was a miscount — the clusters it drew sum to 24 — and two of those did not survive the nav
invariants. The solo island is gone and the spine is four pairs: with the meeting table and the
corner row, a five-pair spine sealed the front strip and the only way east was round the top wall
past the work board. 23 is the as-built count; the table below is the as-built plan.)_

Plan view, north wall at the top, door bottom-left, logical floor 900 × 900 (`iso.ts` FLOOR).
Positions are the mockup's and are the builder's to tune by up to ±40 units to satisfy the
invariants in §5; the *shape* of each cluster is decided.

| Cluster | Desks | Where | Shape |
| --- | --- | --- | --- |
| Back bench | 4 | under the north windows, x≈170–470, ly 56 | one counter, sitters face the wall (as today, 6 units further north so the chairs clear the nav grid's row) |
| Pinwheel | 4 | NW quarter, centre (225, 330) | four desks 85 out from a centre plant, each facing inward so the four face S, W, N, E and the seats ring the outside |
| Spine | 8 | centre (540, 440), pairs at y 290–590 | four facing pairs in a line running N–S; the two columns face each other |
| Zigzag trio | 3 | front-left, centre (235, 595) | three desks stepped diagonally at (−110,−90) E, (0,0) W, (−60,102) E; no two share a row or column |
| Corner row | 2 | SE corner (790, 830), facing S | two desks side by side against the south wall, seats to the north, on a wide shallow rug |
| Window desks | 2 | east wall (776, 400) and (776, 580) | facing W, as today |
| Meeting table | 0 | where it is today (500, 805) | four chairs, unchanged (its size is pinned by its seats) |

_(miley's calls after the builder check, 2026-10-26.)_ The mockup put the meeting table on top of
reception; it stays at today's spot instead. The spine starts at y≈290 so its north-east seat clears
the lounge's coffee table (moved 24 east for the interim; v3-3 re-cuts the café). Slot ids are
sequential over `DESK_SLOTS` (the old `id * 4 + i` stride cannot hold an 8-desk pod), and the
spine lists its W-facing column first so the seating probe's runs land row-mates together.

Pods are no longer only quads/duos/solos: the `Pod` type grows a `shape` of `'quad' | 'duo' |
`'solo' | 'pinwheel' | 'zigzag' | 'spine'` (builder's naming) with its own desk generator in
`podDesks`. The "exactly two desks face S" rule (`layout.test.ts:45`) is **retired**: it existed to
keep viewer-facing monitors rare, and with 28 desks the count that matters is "no more than four
face S"; the pinwheel contributes one, the zigzag at most two.

Reception, the front desk and the work board stay where they are. The huddle stays gone.

### 2.2 Floor — wide staggered planks, small tile under the café

The floor is a rendered asset (`art/office/scene.py` `tiles()` → `floor_slab()`, shipped in the
`room/light-*` shell images). It changes material, not mechanism:

- **Planks.** Boards ~1.6 m × 0.18 m logical, running E–W (along the long sight line from the door),
  joints staggered by a third of a board, three alternating board tones around today's
  `FLOOR_TILE` warmth (builder picks; keep the room's temperature), a fine dark seam.
- **Café tile.** Under the whole north-east café zone, the `CAFE` rect **x 620–896, y 4–330**
  (fridge to the east wall, north wall down past the stools and the couch's south end), small
  square pale ceramic tiles ~0.3 m with light grout, meeting the planks at a straight threshold
  strip. Every café seat and standing spot is inside it.
- **Rugs.** The pod rugs shrink to a thin `border` weave with a near-transparent field so the planks
  show through; they remain the zone markers members name. The nook diamond rug is **removed**: the
  tile is the zone. `NOOK_RUG`, `rug/nook` and the "on the rug" nav check (`nav.test.ts:57`) become
  "inside the café tile rectangle" (a new `CAFE` rect in `layout.ts`).

### 2.3 Café corner

Fridge, counter (machine + sink), cooler stay on the back wall as today. In front of them:

- **Island.** A counter-height island ≈ 180 × 40 logical, wood top on a pale base, x≈640–820,
  ~90 units in front of the counter (so the kitchenette lane stays walkable, with its four dwell
  stands unchanged).
- **Three stools** along the island's front (south) edge, round seats, 65 apart (that is 46 on
  screen, exactly `MIN_SPOT_GAP`; four at 40 apart would smear into one avatar, which is the case
  the constant exists to stop). Each is a leisure spot: `sit: 1`, `casual: true`, facing N.
- **Two-seat couch** (len ~80) in the SE of the café facing W, with **one** sitting spot on it
  (as today's couch: a second cushion is under the gap), **one armchair** facing S beside it, a
  **low table** between them, one **floor plant** in the corner. The couch is today's model,
  shortened. Café seats: 3 stools + 1 couch + 1 armchair = 5, plus two standing spots by the
  island's east end.
- **Who sits where.** §2.9: idle sits, away stands.

### 2.4 Office chairs

`chair_back()` in `scene.py` gets a curved back: the padded panel bends around the sitter in plan
(a shallow arc, radius ≈ 1.2 × back width) and reclines ~8° from vertical, with a slight lumbar
bulge. All five `CHAIR_STYLES` take it; `exec` and `gamer` keep their wings/headrest on the curved
panel. Meeting chairs (`meeting_chair()`) and the new stools get a matching curved back / no back.

### 2.5 Plants

"Messed up" is the two tall fiddle-leafs that read as blobs at this zoom (my read of the
screenshot; builder confirms against `/live`). Both species are rebuilt: the fiddle-leaf gets 6–8
distinct broad leaves on visible stems rather than an 8-ball canopy; the snake plant's blades thin
and gain a light edge. A third species, a **trailing pothos** on a stand, is added for the island
and the pinwheel's centre. Pot proportions follow the v2 figure's scale.

### 2.6 Walking that plants its feet

The glide is a mismatch between the sprite's walk clip and the floor moving under it, not a nav
problem. Three changes in `figure.py` `action("walk")` and the runtime:

- **Stride and ground contact.** The planted foot stays fixed to the floor for its stance half:
  knees drop to 0 and the ankle flexes so the sole reads flat; the swinging foot lifts higher
  (knee to ~50°). Hips ±34°.
- **Body.** Root bob rises to `2.2·|sin|` with a forward lean of 4° in the spine, and the pelvis
  rolls ±3° so the figure's weight visibly transfers. Arms swing ±30° with the elbow trailing.
- **Runtime.** `STRIDE` (`skeleton.ts:24`) is re-measured against the rendered clip so one gait
  cycle moves exactly one stride on the planks (the visual floor now has joints to check against).
  `advanceAnim` keeps distance-driven phase; ease-in/out on a leg's start and end (`STRIDE_EASE`)
  stays.

### 2.7 Less rock

`action("idle")` sway: spine yaw `1.2° → 0.4°`, spine pitch `1.5° → 0.8°`, head `1.2° → 0.6°`,
shoulders ±4° → ±2°. The runtime wisp wobble (`character.ts:236`) is left alone; it is the
speech-bubble stalk, not the body.

### 2.8 Hands down off the desk, laptop under the arm

- A new seated clip **`sit-lap`** (8 frames, loop, four cardinal dirs): spine settled back, both
  hands in the lap, the laptop (`carry/laptop`) tucked under the right arm against the hip. Rendered
  with the `carry/laptop` layer in **this clip as well as** `idle`/`walk`/`speak`/`turn`
  (`figure.py:563-569`).
- `character.ts` `animFor` plays `sit-lap` whenever the seated member is `casual` (couch, armchair,
  stools, meeting table, waiting chairs) and never `sit-type`/`sit-hand` there. The desk arms
  overlay (`render.ts:3511`) is already skipped for `handsInLap`.
- Entering, leaving, and going idle already carry the laptop by the "docked ⟺ working at own desk"
  rule (`seating.ts:91`, `actors.ts:152/780/847`). The visible gap is the seated case above and any
  path where `carry` is null on a walk; the builder audits `leg.carry` producers and makes `'laptop'`
  the fallback for every non-errand walk.

### 2.9 Idle sits, away stands

Today two systems share the corner: **idle** members (online, quiet) take `LEISURE_SPOTS` across
four zones, the couch among them, and sit; **away** members (a declared absence, never inferred)
stand small at `NOOK_SPOTS`, capped at six. Decided 2026-10-26 with nick: **idle members own the
café seats** (the three stools, the couch seat, the armchair join `LEISURE_SPOTS` in the `lounge`
zone, with the meeting chairs and waiting chair as today); **away members keep standing small**
at four standing spots along the island's east end and the café's south threshold, inside the
`CAFE` rect. `NOOK_SPOTS` shrinks to those four; `NOOK_CAP` becomes 4.

Why: away is a human gesture and a rare one. No agent has ever declared itself away (the
availability tool exists since 2026-09-03; the roster has never shown one, and nick's audit read on
2026-10-26 found zero `away` rows). The café serves the common case, and "small and standing"
keeps its one meaning.

## 3 How it gets made

Same toolchain as v2: Blender 5.2 scripts in `packages/web/art/office/` (`scene.py` for the room,
`figure.py` for the figure), `render.py` via `render_watch.py` with the per-call store, assets in
`src/live/office-scene/rendered/assets/`, runtime in `src/live/office-scene/`. No new dependency.

Render cost, from the store's rules (ADR none; wiki `office-render-cost`):

- Room pieces (floor shell, rugs, chairs, plants, café pieces, stools, island) are room renders:
  minutes each, three light states for the shell.
- `walk` and `idle` are figure clips in the base layer set; re-keying them re-renders the body
  clips but **not** the wardrobe layers, because the tee holdout is unchanged. Hours, not a day.
- `sit-lap` is a new clip: it renders across every layer that has a seated variant (body, tops,
  bottoms, hair, facial, acc, carry/laptop). This is the expensive one; estimate half a day of
  render, run overnight.

## 4 Goals, non-goals, anti-goals

**Goals.** 23 desks (28 was the mockup's miscount; see §2.1). A room that reads asymmetric on purpose. Feet that land on a floor that shows
where they land. Idle members who look parked, not typing in the air. A café corner that looks
like somewhere a person would take a coffee.

**Non-goals.** Wardrobe (v2-3/v2-4). New errands or ambient behaviours. Changing the iso camera.
Painted (runtime) furniture; everything new is rendered. Lighting changes beyond re-rendering the
shell.

**Anti-goals.** A floor pattern busier than the rugs. Desks so dense the nav invariants need
exceptions. Any walk cycle that moves the figure faster or slower than its feet (the exact failure
we are fixing). A render that drags `officeArtBytes` past the budget without a logged raise.

## 5 Constraints

- Every seat keeps 60 units of walkable floor behind it and is reachable from `ENTRANCE`
  (`nav.test.ts:34`). Every pair of leisure spots stays `MIN_SPOT_GAP` (46) apart on screen.
  Dwell points (`COFFEE_STAND`, `FRIDGE_STAND`, `COOLER_STAND`, `SINK_STAND`) stay walkable.
  No `MIN_SPOT_GAP` exception: the café offers fewer seats rather than closer ones.
- `layout.test.ts` invariants hold except the retired "exactly two face S" (becomes ≤ 4).
- `officeArtBytes` 8,420,000 (`docs/perf/budgets.json`). Last measured 7,931,556 after v2-2.
  The shell is three images at half res; the new clip is the risk. If a raise is needed it is
  logged in `docs/perf/web-live-baseline.md` in the same PR.
- No local full-suite runs on the shared laptop; renders run in the background with the store
  so they resume. Each increment is a lane and a PR; the lane body carries the plan's row.
- Accessibility gates are unaffected (canvas), but `/live` and `/broadcast` are checked by eye
  after each publish, at 1456-wide and at 390-wide.

## 6 Increments

| # | Lane | Lands |
| --- | --- | --- |
| v3-1 | `01M5X4Q7NFKJ69KVHR38T47YMG` | Layout E in `layout.ts` + `scene.py` placements, new pod shapes, nav/leisure spots, meeting table shrunk; rugs thinned; **old floor** (so the layout can be judged alone) |
| v3-2 | `01M5X4QT79GZN81NKB67GEVMG8` | Planks + café tile shell render; nook rug removed; `CAFE` rect |
| v3-3 | `01M5X4QWV9888X2JN9WYQCH61C` | Café corner furniture: island, stools, short couch, armchair, table, plant; idle sits, away stands |
| v3-4 | `01M5X4QYB290SKE0D72DR5PWSS` | Chairs curved; plants rebuilt + pothos |
| v3-5 | `01M5X4QZ786Z4XS68R4MFPNX8J` | Walk re-keyed, idle sway cut, `STRIDE` re-measured |
| v3-6 | `01M5X4QZXKVDAQK8DGC2SMSAA0` | `sit-lap` clip, casual seats play it, laptop carry audit |

v3-1 first so nick can react to the room before the floor changes under it. v3-5 and v3-6 are
figure renders and can run overnight in parallel with v3-2..4.

## 7 Left to the builder

Exact coordinates within the ±40 tune; board tones; pot models; the pinwheel's centre plant species;
stool model; the `Pod.shape` naming and `podDesks` generators; whether the meeting table keeps its
rug; `STRIDE` value after measurement; frame count of `sit-lap` if 8 proves too few for the loop.

## 8 Risks

- ~~28 desks may not all clear the 60-unit rule at the mockup's positions~~ — they did not: the
  solo and the spine's fifth pair went (§2.1). Any further desk needs a nav map first
  (`nav.test.ts` can dump one: mark seats and `walkable` cells on a 60×60 grid).
- The planks' E–W grain under an iso camera may strobe during the walk; if so, rotate the grain
  N–S (one re-render of the shell).
- `sit-lap` across all layers could push bytes over budget; the fallback is rendering it at the
  four dirs but with `acc/*` and `facial/*` reusing their `sit-idle` frames (same head pose).
