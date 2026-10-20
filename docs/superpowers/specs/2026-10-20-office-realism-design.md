# The office, re-made: a realistic, cozy room and believable people on /live and /broadcast

**Date:** 2026-10-20
**Seat:** miley
**Status:** design agreed with nick in the brainstorm on 2026-10-20 ("yes go with that"). Nothing is
built.
**Lanes:** this document is lane `01M5D79CFYX6R7J9FWD0K0J63D` (goal `live-delight`). The build
increments are opened under a Goal once the plan is written; each row of §9 names its lane when it
exists.
**Builds on:** the office scene as it stands (`packages/web/src/live/office-scene/`, read order:
`layout.ts` → `iso.ts` → `render.ts` → `skeleton.ts` → `actors.ts` → `sprite-cache.ts`), its
sprite-cache spec ([2026-09-17](2026-09-17-office-scene-sprite-cache-design.md)), the hosted stream
([ADR 642](../../decisions/642-hosted-stream-x11-30fps.md), [hosted-broadcast](../../guides/hosted-broadcast.md))
and the perf contract (`packages/web/AGENTS.md`, [ADR 151](../../decisions/151-perf-budget-raise-log.md),
[ADR 183](../../decisions/183-two-js-budgets-two-remedies.md)).

## 1. What nick asked for, in his words

The office today is "intentionally 2d birdseye gameboyish, isometric". He wants it "more 3d and
smooth looking", "realistic, smooth, and cozy at the same time", and explicitly **not** "the chunky
shiny figurine quality" — "stylized people are fine". The office must stay as big on screen as it is
now. The members become "more expressive figures that walk, sit and gesture". Of materials, detail
and lighting, "all three but mostly the materials and lighting". And: "it is important for the twitch
broadcast to run extremely smoothly with very low latency".

He named a game he likes the feel of and asked that we not copy any game's style. This document
names none and borrows none; the look is ours.

## 2. What is decided (the picks, as he made them)

Each of these was chosen from mockups during the brainstorm. They are the brief for the art, not
suggestions.

### 2.1 The figure

- **Proportion:** about **five heads tall** (nick picked the middle of 4.3 / 5 / 5.7). Shorter
  than that read as a toy; taller read as a real adult and too small on the floor.
- **Body:** torso with a **slight waist**, shoulders a little wider than the hips; trousers with a
  **real pelvis and seat** ("I want an actual lower body, not just the legs"); legs with a knee;
  shoes. Two arms, two legs, always.
- **Head:** an oval with a jaw on a short neck. A **structured face**: eye sockets with whites and
  an iris, lids, brows, a nose with nostrils and a shadow, lips with a top and a bottom, cheekbone
  and temple shading, ears with a fold. A ball head, a helmet of hair and a peg neck were each
  rejected in turn as "toy".
- **Hair** has a real silhouette and strands with a highlight, and is where much of a member's
  identity lives (a side part, a close crop with beard shadow, a low bun, waves with glasses, …).
- **Materials:** matte. Knit, denim, cloth, skin. No specular dot, no plastic. No line work; shading
  does the drawing.
- **Motion:** walks with weight (lean into the stride, settle on stopping), sits at a desk leaning
  in, gestures when speaking or handing work off. Nothing snaps between tiles.

### 2.2 The camera

- **Corner view**, as today: two walls meet at the back of a floor diamond. nick tried a straight-on
  elevated three-quarter view and came back: "i might still like the corner of the room angle".
- **A touch lower than today**, so figures stand up and faces face the viewer. In the mockup this
  was a floor diamond with vertical/horizontal ratio 0.40/0.62 against isometric's 0.5/0.866 — the
  builder calibrates the exact angle in §6.2, the brief is "lower than now, the whole floor still in
  the panel".
- **The full floor always fits the panel.** No scrolling, no camera following. The room panel keeps
  its size on /live and on /broadcast.

### 2.3 The room

- **Light** is the main event: windows on one wall, daylight falling across the floor in warm pools,
  lamps on the desks, a soft contact shadow under everything. The scene already has a time-of-day
  light environment (`lighting.ts`: `computeLightEnv`, `sunBeam`); the new room keeps day, evening
  and night.
- **Materials read as what they are**: wood with grain and a worn edge, fabric on chairs, paper on
  desks, monitors that glow a little, leaves on plants rather than a leaf-shaped blob.
- **Detail** is third: mugs, cables, papers, desk lamps — enough to be lived-in, never so much it
  competes with the people.
- **Cozy** is warmth plus small ambient life: a screen that flickers, steam off a mug, a plant that
  sways. (My guess from "cozy"; nick has not picked these individually.)
- **The layout does not change.** The three pods, the bench, the two window desks, the nook, the
  lounge and reception stay where `layout.ts` puts them. The re-make is a re-rendering of the same
  floor, so nav, seating, arrivals and every test that reasons about floor units keep working.

## 3. How it gets made: pre-rendered art, not a 3D engine

Three routes were weighed with nick. He chose **pre-rendered art** after asking what each costs at
runtime.

| Route | Look ceiling | Runtime cost (viewer tab) | Broadcast box | Download |
| --- | --- | --- | --- | --- |
| Push the hand-drawn painters | better vector art | ~today (2–2.5% of a core) | unchanged | +0 |
| **Pre-rendered art** (chosen) | real materials and lighting | ~today | unchanged: blits images, as now | +hundreds of KB, measured |
| Real-time 3D (WebGL) | the most game-like | 15–40% of a core + GPU | Xvfb has no GPU: software-rendered every frame beside the encoder | +150–600 KB engine |

The deciding fact is the broadcast: `musterd-broadcast` runs headless Chrome in Xvfb and encodes
1080p30 on the same CPU, and the sprite-cache spec measured ~39 of ~56 ms per draw going to static
furniture rasterised through SwiftShader before caching. A route that adds per-frame computation
there is a route that drops frames. Pre-rendered art is the one route where **the broadcast's
per-frame work goes down, not up**: the room is one blit, and a figure is one blit per frame.

### 3.1 The room

The room is built once as a 3D scene and rendered to **image layers**, from the agreed camera, at the
scene's logical resolution with a 2× variant for retina. Layers, back to front:

1. **Walls and floor** (one image per lighting state: day, evening, night — §3.3).
2. **Static furniture**, one image per depth slot so the existing depth sort still decides what a
   figure stands in front of or behind. A desk is one sprite; a pod rug is one sprite. This is the
   sprite-cache's model, with a rendered PNG where today a draw function runs.
3. **Shadows and light pools** as separate translucent layers over the floor, so the lighting state
   can crossfade without re-shipping furniture.
4. **Wall objects** (board, calendar, clock) keep their live content: the rendered layer carries the
   frame, the canvas keeps painting the numbers and the days on it as it does today.
5. **Per-desk live state stays** (my call). A desk today is not static (`drawWorkstation`): its lamp
   shows only when occupied and dark, its screen changes when the owner is working, its props (fan,
   mug) move only with someone there, and the ceiling lights follow occupancy and declared working
   hours (`overheadOn`, `afterHours`). So a desk is a base sprite plus small overlays — lamp on and
   its pool, screen on, the animated prop — and the room's light layers include ceiling on / off /
   after-hours spill as well as day / evening / night. Nothing the room does today goes away.

Interactive things stay interactive: the board hotspot, the hours tab, nameplates, bubbles and the
asks bar are DOM and CSS, unchanged by this document.

### 3.2 The figures

Figures are rendered from **one rigged 3D character** to **sprite sheets**: a set of facing
directions × animations × frames. The existing actor state machine (`actors.ts`: home poses, walks,
idle gestures, typing bursts, arrivals) keeps deciding *what* a figure does; `drawCharacter` stops
solving a skeleton and instead picks a frame.

- **Directions:** 8 (the corner view needs the diagonals; the walk paths run on them).
- **Animations (first cut):** idle stand, walk, sit-type, sit-idle, stand-gesture (speak), turn
  head, sit-down / stand-up. Each is a short loop or a short one-shot; frame counts are the
  builder's, with the stream's 30 fps as the clock.
- **Motion parity before the flag comes off** (my call). Today's scene has ~21 idle gestures
  (`skeleton.ts` `GESTURE`: stretch, sip, swivel, rub eyes, phone, eat, pour, browse, wave, the
  reach/take at the wall board, …), carried props (laptop, plate, box, card) and continuous heading
  and chair yaw. The first cut above is what increment 3 ships behind the flag; increment 3b
  (§9) brings the rest to parity, because a trimmed office is a regression the anti-goals forbid and
  the Welcome Wagon wave and board reach are product behaviour, not decoration. `actors.test.ts`
  stays green throughout: the state machine does not change, only what a state draws.
- **Identity:** a member's figure is composed from layers rendered separately from the same rig,
  so the builder can swap and tint per member. `appearance.ts` already derives a member's look from
  their name — skin tone, hair shape and colour, facial hair, hat, top cut, trouser and shoe
  colours, glasses / headphones / scarf — and that derivation **stays the source of truth**; the
  sprite layers are its new rendering. Layers (my call): skin, hair (per shape), facial hair, top,
  trousers, shoes, accessory, each rendered neutral and tinted at runtime from the appearance, so
  the sheet count is shapes × directions × animations, not colours. The face is the same across
  members at office scale; close views may add per-member faces later, out of scope here.
- **Agents are told apart from humans by the visor**, which `appearance.ts` calls "the one tell the
  office cannot afford to lose"; it is its own layer and always present on an agent. Whether the
  non-human skin tints agents carry today (mint, seafoam, periwinkle) survive into the realistic
  look is **nick's call** (open question at hand-over).
- **Scale:** one sprite scale per depth band, so a figure at the back is smaller than one at the
  front, as in the corner mockup.

### 3.3 Lighting states

The room ships three rendered lighting states. `computeLightEnv` keeps its clock; the renderer
crossfades between the two nearest states instead of tinting painters. Figures carry a matching
light direction in their render (one key light from the window side), and a single multiply tint
per state keeps them in the room at night.

### 3.4 Tooling

**Blender** (free, scriptable, not on this laptop today). The scene, rig and render are a Blender
file plus a Python render script committed under `packages/web/art/office/`, so every sprite sheet
is regenerable from source and the next change to a desk is a re-render, not a redraw. Rendered
PNGs are committed as build inputs (gitattributes: binary). This is a **tool**, not a runtime
dependency: nothing new ships to a viewer but images.

The alternative — commissioning or image-generating the art once and committing the pictures — was
rejected because it cannot be re-rendered when the layout or the camera changes, and it cannot
produce consistent sprite sheets for the figures.

## 4. Goals, non-goals, anti-goals

**Goals**

- The office reads as a real, warm room: materials and lighting first, detail second.
- Members read as people: posture and gesture visible from across the room.
- The whole floor on screen at the same panel size as today, on /live and /broadcast.
- The broadcast's per-frame cost is **no higher** than today; latency unchanged.

**Non-goals**

- Changing the floor layout, nav or seating.
- Real-time 3D, dynamic shadows, physics.
- Per-member faces (hair and outfit carry identity in this round).
- Any change to the DOM overlays (bubbles, nameplates, board, hours tab, asks bar).

**Anti-goals** (would make this a failure even if it worked)

- Anything that reads as a shiny toy or a figurine.
- A look that could be mistaken for a specific game's.
- Dropped frames or added latency on the Twitch stream.
- A room so detailed the people are hard to find.

## 5. Constraints

- **Perf contract** (`packages/web/AGENTS.md`): image bytes are not yet a budget; this work **adds
  one** (`officeArtBytes`) in its first increment and logs the measured cost in
  `docs/perf/web-live-baseline.md` (ADR 151). The ceiling is set the way the others are: measured
  after increment 2 (room) and again after 3 (figures), +15% (ADR 183), never designed to in
  advance. Art is rendered sharp for the 1080p broadcast panel at DPR 1 and the /live panel at DPR 2
  — one 2× source per asset, downsampled by the canvas for smaller fits, as the fonts and the
  office still are today. JS budgets must not rise for this: sprite picking is less code than
  skeleton solving.
- **No `backdrop-filter`, no per-frame blur** — the office-block house rule, for the stream.
- **Dirty-rect repaint** (ADR 625) stays; a sprite frame change marks exactly its rect.
- **Hidden-tab pause and collapsed-panel suspend** stay.
- **Contrast and tap-target gates** (`a11y:check`, `a11y:targets:check`) run on /live; the rendered
  room must keep nameplate and bubble contrast where they land.
- **Copyright:** the art is original. No game's assets, palettes or character designs are
  referenced in the Blender file.

## 6. Left to the builder

1. **The art itself.** This document fixes proportions, materials and camera; the builder (with
   nick's eye at each increment) designs the actual furniture, palette and figure.
2. **Exact camera angle** within "lower than isometric, whole floor fits".
3. **Frame counts and sheet packing**, within the byte budget.
4. **How `drawCharacter` and the depth sort consume sprite frames** without changing draw order.
5. **The lighting-state crossfade** and how figures are tinted per state.
6. **Whether the welcome room, pet and receptionist** (`welcomeRoom.ts`, `pet.ts`,
   `receptionist.ts`) get re-rendered in the first pass or keep their painters until a later
   increment. Mixed is acceptable only behind a flag during the build.
7. **The hero crop.** The musterd.io hero and `/office-preview` draw this same scene through
   `fitFloor` / `ROOM_BOX`; they switch with the flag's removal (the painters are deleted, which is
   what keeps the JS budget flat), and the hero's framing of the full wall height is the builder's.

## 7. Rollout

Behind a flag (`?office=rendered`) until nick accepts it on /live; then /broadcast; then the flag
goes. Each increment lands with a capture nick can look at, the way the brainstorm went.

## 8. Risks

- **Art is slow.** Modelling a room and rigging a character is days, not hours. Mitigation: the
  room first (one static render proves the look), figures second.
- **Sprite sheets are big.** 8 directions × ~7 animations × frames × 3 identity layers × 2×.
  Mitigation: measure after the first sheet; cut directions to 4 + mirroring if needed; WebP where
  it reads identically.
- **Mixed old/new looks worse than either.** Mitigation: the flag, and no partial ship.
- **Blender is not installed and not scripted anywhere in this repo.** The first increment proves
  the pipeline on one desk before anything else is modelled.

## 9. Increments

| # | Increment | Proves | Lane |
| --- | --- | --- | --- |
| 1 | Pipeline: Blender scene + render script → one desk sprite drawn by the sprite cache behind the flag; `officeArtBytes` budget added | the toolchain and the byte cost | _(opened after the plan)_ |
| 2 | The room: walls, floor, all furniture, lighting states (day/evening/night × ceiling on/off/after-hours), per-desk overlays, crossfade | the look nick asked for, at the agreed camera | |
| 3 | The figure: rig, sprite sheets, identity layers, `drawCharacter` picks frames | people who walk, sit and gesture | |
| 3b | Motion parity: the remaining idle gestures, carried props, board reach, the wave; per-desk overlays | nothing the office does today is lost | |
| 4 | Ambient life, welcome room, pet, receptionist; flag removed; /broadcast capture compared frame-for-frame against today | the whole floor, stream-safe | |

A several-step plan is a Goal with every step's lane (ADR 487); the Goal is declared when the plan
is written.
