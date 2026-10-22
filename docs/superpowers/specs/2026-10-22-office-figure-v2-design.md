# The office figure, v2: softer, connected people with more realism, and a much wider wardrobe

**Date:** 2026-10-22
**Seat:** miley
**Status:** design agreed with nick in the brainstorm on 2026-10-22, builder-checked the same day. Nothing
is built.
**Lanes:** this document is lane `01M5JFNXC675VNJPZ8A271NS3G` (goal `office-realism`). The build
increments get their own lanes under the same goal; §8 lists them.
**Builds on:** the office realism design ([2026-10-20](2026-10-20-office-realism-design.md)), which this
amends where it fixed the figure (§2.1 proportion, §3.2 identity layers); the figure pipeline as it
stands (`packages/web/art/office/figure.py`, `render.py`, `figure_resample.py`, the README beside them);
the runtime that draws it (`packages/web/src/live/office-scene/rendered/figureSheet.ts`, `figure.ts`) and
the wardrobe that decides who wears what (`packages/web/src/live/office-scene/appearance.ts`).

## 1. Why, in nick's words

The rendered office "looks great", but the people are "a little off". The painted figures "look more
warm/cuter and more rounded and less boxy"; the rendered ones "look too much like tubes and boxes" and
should be "a little more smooth/connected". A test that moved most of the way toward the painted figures
was "too playmobile like": "i wanted some realism which is why i think we went the rendered direction.
but again we need to find balance". The version this document describes was, at test-render stage,
"much better".

And the wardrobe has to grow: in an office "some people like a more formal look — dresses, collared
shirts, khakis etc. some people like a more casual look — tshirts, jeans, athletic shoes etc. Some people
like to wear headbands, earrings, glasses, headphones, watches. some people like to style their hair more
or less formal or casual. some people like to look very well groomed, some people not so much. so we need
a wide variety."

## 2. What is decided

Each of these was chosen from test renders in the brainstorm (the spike scripts are throwaway and not in
the repo; the renders are described here so the decision does not depend on them).

### 2.1 The body

- **Proportion: about 4.7 heads**, a quarter of the way from today's rendered figure (5 heads) toward the
  painted one (3.7). Halfway (~4.3) and three-quarters (~4.0) were both tried; nick put the target
  "between A and B" (5 and 4.3). The crown stays where it is today, so labels, bubbles and the seat
  geometry do not move: a bigger head means a slightly shorter body under it. This amends the
  realism design's §2.1, where 4.3 read as a toy; the difference now is the realism cues below.
- **Connected, not jointed.** Shoulders flow into arms and hips into legs. No tube ends, no shoulder or
  elbow caps, no seam at a joint, in any pose. Each continuous surface (the skin, a top, the trousers,
  the hair) is one soft shape.
- **Real anatomy inside the softness.** Limbs taper to the wrist and the ankle; a waist; shoulders
  slightly wider than the hips; a neck that reads as a neck; hands with a palm and a thumb, sized so they
  read at office scale. The toy look came from everything being one thickness and one smoothness; the
  tapers are what stop it.
- **One height for everyone.** Build varies **only** by drawing the figure 3–6% wider or narrower
  (a per-member horizontal stretch at draw time, derived from the name like every other pick). nick:
  "too much variation in avatar build" is the first thing that would make this a failure.

### 2.2 The face

A jaw and cheeks, so the face has a chin rather than being a ball; eyes with a white, an iris that catches
the light, and a lid of skin over the top; brows; a small nose; lips. Warm, not a toy's dots and slit.
Agents keep the visor across the eyes (the realism design's §3.2: the one tell the office cannot lose).

### 2.3 Materials

- **Skin** lets a little light through (subsurface), so it reads as skin and not paint.
- **Cloth** is matte with a visible weave; denim, knit and shirting may differ.
- **Hair** is sculpted in clumps, not a helmet, with a strand texture that catches the light.
- Nothing shiny except what should be: glasses frames, a watch face, a buckle, an earring.

The room, its lighting and the camera do not change.

### 2.4 The wardrobe

**Every existing piece is upgraded** to the new detail (today: 5 tops, 8 hair styles, 4 facial hair, 3
hats, 3 accessories), **and many more are added**. The test renders set the bar for detail: ribbed cuffs
and hem, drawstrings and a front pocket on a hoodie; a collar, a button placket and buttons on a shirt;
sleeves rolled above the elbow; rolled jeans; a belt with a buckle; soled sneakers against leather shoes;
thin round glasses; a watch.

The wardrobe is organised by **style**, because people dress in a style, not a random mix:

| Style | Pieces (the builder may add) |
| --- | --- |
| Formal | collared and button shirts, blouses, dresses, skirts, tailored trousers, khakis, blazer, cardigan, leather shoes, loafers, flats |
| Smart-casual | polos, knit sweaters, chinos, dark jeans, clean sneakers, boots |
| Casual | t-shirts, hoodies, flannels, jeans, joggers, sneakers |
| Athletic | sport tees, zip jackets, track pants, running shoes |

**Accessories cut across styles:** headbands, earrings (studs, hoops), glasses (several frame shapes),
headphones (on the ears, around the neck), watches, bracelets, scarves, caps and the other hats. A member
can wear **several at once, one per spot**: eyes (glasses), ears (earrings, on-ear headphones), wrist
(watch, bracelet), head (hat, headband), neck (scarf, headphones around the neck). Each spot is its own
pick and each stays rare, so most people wear none or one. **Do-not-disturb still reads as on-ear
headphones**, as `lookFor` does today: they take the ears spot, and headphones worn around the neck move
up onto the ears.

**Layered tops:** an outer piece (blazer, cardigan, zip jacket) is its own layer worn over a shirt or a
tee.

**Hair and grooming come in polished and unkempt versions:** neat side-parts, slicked back, buns, tidy
bobs at one end; messy, tousled, curly, loose at the other. Facial hair: clean-shaven and trimmed against
stubble and untrimmed. Grooming is picked **separately** from style, so a formal dresser can have messy
hair. **Grooming is one dial per member covering hair and facial hair**: it chooses whether hair and
facial hair are drawn from the polished pool or the relaxed pool. Most styles live in one pool; only a
few (a bob, a beard) come in both a neat and a messy version, so grooming does not double the layers.

A **dress** (or any one-piece) is worn **instead of** a top and a bottom: it changes the shape of the
legs, so it cannot sit over trousers. A skirt is a bottom.

### 2.5 Who wears what

- **Nothing is tied to gender or race, and nothing encodes a gender or racial stereotype** (nick: the
  other thing that would make this a failure). Dresses, skirts, earrings, buns, long hair and beards are
  open to anyone. Style, grooming, hair, each accessory and skin are independent picks from the name.
- **This retires `presents`** (`appearance.ts`), the femme/masc/neutral axis that coordinates hair length
  with facial hair (nick, 2026-10-22: yes). It was added (2026-07-30) because the floor read as all male;
  under nick's rule a long-haired member with a beard, or a bearded member in a dress, is a person, not a
  mismatch. The guard against the floor drifting back is **pick weights, never coupling**: long hair,
  dresses, skirts and earrings are weighted to stay common, each picked on its own.
- **Skin stays full-rainbow**, as `appearance.ts` already deals it: deep browns through mint and peach,
  not a "realistic" ramp. Hair and hat colours keep contrasting with the skin (`pickContrasting`).
- **The outermost top carries the member's identity hue** (`appearance.ts`: it is how you find someone on
  the floor): a blazer, cardigan or zip jacket over a shirt takes the hue and the shirt under it runs
  free; with no outer layer the top takes it, and so does a dress (nick, 2026-10-22). Other pieces run
  free.
- **A member's look is still a pure function of their name**, stable across frames, reloads and
  machines. The new wardrobe reshuffles everyone's look once; that is expected (the wardrobe was always
  "stable per name", never "these people look like this").
- Agents: no glasses, no facial hair, the visor always (unchanged).

## 3. How it gets made

The pipeline stays as it is: one rig in `figure.py`, rendered per clip, direction and frame into
per-layer sheets by `render.py`, tinted at runtime from `appearance.ts`. What changes:

- **The base body becomes skin only, legs included.** Today the base is skin, bottom, shoes and visor,
  split by ID and used as every other layer's holdout. Skirts and dresses need bare legs, and bottoms and
  shoes now come in different shapes (skirts, joggers, rolled jeans, boots), so v2-1 moves bottoms and
  shoes out of the base into ordinary pieces, each rendered with the skin (and visor) as its holdout. Where
  two pieces overlap, the draw order decides: shoes, then bottom, then top, then outer layer, and the hair
  and accessories after; a top always sits over the trousers (untucked; a tucked look is drawn by the top
  ending at the waist under a belt). Where a seated pose needs a different order (thighs in front of a
  hem), the builder sets it per clip. This is in v2-1 because it changes the body, and only the body
  re-renders everything.
- **Each continuous surface is fused before it renders.** After a frame is posed, a layer's parts are
  joined and rebuilt as one smooth surface (in the spike: a voxel remesh then a light smooth, which
  removed every seam; the builder may choose differently). This runs on every render call and adds to
  its cost (§6).
- **New pieces are new layers**, and a one-piece is a new kind of layer that replaces a top and a bottom
  for the member wearing it. The per-call store keeps working: a piece's renders depend on the body and
  itself, so a new or changed piece renders alone.
- **Build stretch** is a horizontal scale in the draw call (`figure.ts`), not a render.
- **`appearance.ts` gains style, grooming and per-spot accessory picks** and drops `presents`;
  `figure.ts` maps the new fields to layers, as it maps the current ones. The painted office reads the
  same `appearanceOf`, so **this lands only after the painted office is retired** (realism increment 4);
  until then the new pieces wait behind the old picks and the default office never meets a piece it
  cannot draw.

## 4. Goals, non-goals, anti-goals

**Goals**

- People who read as warm, soft and connected, with enough realism that they never read as toys.
- A floor where people visibly dress differently: formal, casual, athletic; polished and unkempt.
- Every change after the body is a small PR with a short render.

**Non-goals**

- Different heights or real body shapes (the stretch is the whole of build variation).
- Per-member faces.
- Changes to the room, lighting, camera, motion clips or the actor state machine.

**Anti-goals** (failure even if it works)

- Too much variation in build.
- Anything tied to gender or race, or any gender or racial stereotype.
- A Playmobil or figurine look: same thickness everywhere, plastic surfaces, helmet hair, dot faces.
- The tubes-and-boxes look it replaces: visible joints, caps, flat ends.

## 5. Constraints

- **Perf contract** (`packages/web/AGENTS.md`). `officeArtBytes` measures every office image the build
  carries, so it **rises** as pieces are added; each increment that raises it logs the measured cost in
  `docs/perf/web-live-baseline.md` (ADR 151/183). What a viewer downloads is only what their team wears
  (lane `01M5GX1F3J`), so a piece costs a viewer bytes mostly when someone wears it. JS budgets do not
  move for art; the appearance and mapping code is small.
- **Figure scale stays 1.5 px per floor unit** (lane `01M5J8DXCH`).
- **The broadcast** frame cost does not change: the draw is the same number of layer blits, one more
  scale per figure.
- **Contrast and tap-target gates** are unaffected (no DOM change).
- **Original art.** No game's character designs.

## 6. Render cost and the increments

Every clothing layer renders with the body as a holdout, so **changing the body re-renders every layer**:
that is the one long render, about two hours or more with the fusing step (today's full figure is ~80 min
at 1.5). It runs overnight and resumes on a hang, as today. The scale-down trick does not apply because
the shapes change.

After that, **a change renders only its own layer**: upgrading the tops renders the tops, a new piece
renders that piece, minutes to ~20 min each. That is how nick's "push smaller changes and keep going"
works: each increment below is its own PR.

Before the long render, the body is checked **in /live at office size on a few frames** (one clip, a few
directions) with nick, because the figure can only be judged there.

## 7. Left to the builder

1. The art: exact shapes, tapers, the fusing method, materials, the frame shapes of the glasses.
2. Which pieces go in which increment, and the exact catalogue within §2.4's styles. Whether a piece
   like jeans has a fixed colour or a free palette pick.
3. How a one-piece is stored and drawn (a layer kind that hides the top and bottom; the arms overlay
   rule for seated clips must hold).
4. The stretch's range within 3–6% and how it is derived.
5. Pick weights: how often each style, accessory and grooming level appears, so the floor looks varied,
   no piece becomes a uniform, and long hair, dresses, skirts and earrings stay common (§2.5). Rare things
   stay rare (hats are today's precedent).
6. Which accessories an agent can wear beside the visor (no glasses, as today; earrings and headbands
   are the builder's call).
7. Per-clip draw-order exceptions for seated poses.

## 8. Increments

| # | Increment | Render | Lane |
| --- | --- | --- | --- |
| v2-1 | The body: proportions, fused surfaces, anatomy, face, materials; skin-only base with legs, bottoms and shoes as pieces; today's wardrobe re-fitted; checked in /live on a few frames first; the build stretch in `figure.ts` | full, ~2 h+ | `01M5JHEEGT55EDJYG51H6ZAQVJ` |
| v2-2 | Tops upgraded (cuffs, hems, collars, drawstrings, plackets) | tops only | `01M5JHEGY8S4BSJDWS1M6SYZMG` |
| v2-3 | Hair and facial hair upgraded, with polished and unkempt versions | hair, facial | `01M5JHEK4HNPFY7XC3RKQWJFV9` |
| v2-4 | Hats and accessories upgraded; earrings, headbands, watches, bracelets, headphones around the neck, more frames | accessories | `01M5JHENHB2ACVDJ767XP0RH8X` |
| v2-5 | Style, grooming and per-spot accessory picks in `appearance.ts`, `presents` retired; outer layers; the first new pieces of each style. After realism increment 4 | new pieces | `01M5JHERVT03C6VDN13M8FE3NK` |
| v2-6… | More pieces per style, including the one-piece layer and dresses, a few per PR | new pieces | `01M5JHEV51D8G1FKGSNVK9CJ81` |

Order: v2-1 → nick accepts the rendered people → realism increment 4 (flag off, painters deleted) →
v2-5. v2-2 to v2-4 can land before or after increment 4; they only upgrade pieces the painted office
never draws.

## 9. Risks

- **The fused render is slower than estimated.** Measure on the /live check frames; if the full render
  would pass ~4 h, split it across nights (the store resumes).
- **Bytes.** Seventy-odd pieces at today's ~150 KB per sheet would roughly double the figure's build
  bytes. Mitigation: worn-only loading already in place; measure per increment; cut frames or directions
  for rare pieces if needed.
- **A one-piece breaks an assumption** in the layer draw order or the seated overlay. Prove it with one
  dress before adding more.
- **Reshuffle surprise.** Everyone's look changes at v2-5. Say so in the PR.
