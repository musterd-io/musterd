# Office decor refresh — fine art on the walls, things on the floor, books that look like books

**Date:** 2026-11-03 · **Owner:** miley (designer) · **Asked by:** nick · **Status:** design, not built

Brainstorm screens (session-local, not committed): four sample paintings at full size and at room size,
the office at 1pm with candidate floor spots, a close-up of today's bookshelf.

**The four samples nick saw** (Z-Image-Turbo, 1152×864, 8 steps, shift 3, 2026-11-03). They are
candidates, not finals: they may be re-generated from these prompts and seeds, cropped to their frames,
and must still pass the provenance check.

| Direction | Seed | Prompt |
| --- | --- | --- |
| Impressionist landscape | 877641 | An original impressionist oil painting of a quiet river landscape at golden hour, loose visible brushstrokes, thick impasto, warm ochre and soft green palette, museum quality fine art, the painting fills the whole frame, no frame, no text |
| Abstract colour field | 45818 | An original abstract color field painting, large soft-edged rectangles of deep terracotta, ochre and slate blue on canvas, layered translucent acrylic washes, visible canvas texture, museum quality modern fine art, fills the whole frame, no frame, no text |
| Classical still life | 301698 | An original classical still life oil painting, a ceramic jug, lemons and a folded linen cloth on a wooden table, dark warm background, chiaroscuro lighting, fine brushwork, museum quality fine art, fills the whole frame, no frame, no text |
| Mid-century modernist | 190166 | An original mid-century modernist painting, abstracted coastal hills and a single tree in flat interlocking shapes, muted olive, rust and cream palette, gouache texture, museum quality fine art, fills the whole frame, no frame, no text (has a fake signature bottom right: crop or regenerate) |

## Intent

The office on /live is rendered since 2026-10-23: lit faces, soft shadows, a warm room. Three things in
it still read as placeholders, and nick named all three on 2026-11-03:

- **The art on the walls is too simple, and the prints are smaller than their frames.** The five frames
  are rendered in Blender, but the picture inside each is a flat motif (arches, a Bauhaus square, a
  cairn, a sunrise) painted at runtime on the canvas, and it does not fill the opening.
- **The floor has little decor.** The desks, the meeting table, the lounge and reception are there; there
  is nothing on the floor that is there only to be looked at.
- **The books are blocks.** Each shelf row is a run of evenly spaced, same-depth coloured boxes.

The wall colour is fine and stays (nick).

## Goals

1. **Fine art in every frame.** Each of the five pictures is an **original painting that looks like it
   could be fine art**, not a recognisable work (nick: "not recognizable no, but looks like they could
   be fine art"). The set is a **mix of four directions**, like a collector's wall: an impressionist
   landscape, an abstract colour field, a classical still life, a mid-century modernist piece. nick saw
   one sample of each and said "they all look fantastic".
2. **The picture fills its frame.** Each painting fills the frame's opening up to a thin mat. No
   floating motif with bare mat around it.
3. **Things to look at on the floor:** about **three display pieces** placed in open floor, clear of the
   walking paths. For example: a sculpture on a plinth by the meeting table, a tall installation near
   the lounge (a mobile, or a cluster of tall vases), a floor lamp with a sculptural piece by the back
   corner shelf. Small furnishings round it out: a second rug, a magazine rack, a coat stand by the
   door.
4. **One new place to sit: a reading nook.** An armchair, a floor lamp, a small side table with a book
   stack, maybe a plant. It goes **by the corner bookshelf**, in the back corner where the two walls
   meet, near the big landscape painting: a reading chair beside the books (nick chose this,
   2026-11-03). **Reception is not touched.** nick cut it to one waiting chair and an end table on
   2026-08-02 ("a waiting room, not a second lounge"), and the door's floor stays clear. The figures
   treat the nook like the couch:
   an idle member sometimes walks over and sits there (nick: "maybe 1 new place to sit. the rest just
   furniture").
5. **Books that look real** on every shelf (nick): different heights and thicknesses, some leaning,
   some stacked flat, spines with bands. Likely also gaps and the odd object or bookend. **Things on
   top of the bookcases too** (nick: "we can also put stuff ontop of the top shelf of bookcases"): a
   few objects per unit, like a small plant, a vase, a globe, a box or a trophy, sized so they read
   on the unit's top.
6. **Three signs that delight** (nick: the signs "need work … not polished enough, not magical,
   beautiful, delightful enough"). The three are the **wiki** sign over the wiki shelf, the
   **settings** tab under the working-hours calendar, and the **work board** sign over the lane board.
   nick picked direction A from three mockups: **carved oak with raised gold-leaf lettering, hung on
   short brass chains, each with a small brass picture light above it**. All three share that family.
   The calendar card and the board frame take the same oak-and-gold finish; the hours, the days and
   the notes on the board stay live data, set in the same gold and cream so they look engraved.
   **The lamps glow after dark** and throw a soft warm pool on the wall; by day they are just brass.

## Non-goals

- No change to the wall colour, the windows, the window views or the drapes.
- No interactivity: nothing is clickable, and the art does not rotate or change by day.
- The books stand for nothing. They are not wiki pages, lanes or anything from team data.
- No more than one new seat. The display pieces are not destinations.
- No change to the figures.
- **No change to what the signs do.** Wiki opens the wiki, the calendar opens settings, the board
  opens the work board, exactly as now; /broadcast still shows them and nothing opens. Their hover
  promise (the lift and warm glow on the hotspot) stays.

## Anti-goals (a failure even if it works)

- **Copying real art.** No painting may reproduce or closely resemble an existing artwork, or carry
  anything that reads as a real artist's signature. nick: "make sure we are not copying any actual art
  so we dont get in trouble legally". See Constraints, "Provenance".
- **A pasted-on look.** A painting or prop that ignores the room's light (bright paint at night, a
  glossy PBR texture in a matte room) is worse than the simple shapes it replaces.
- **Clutter.** A floor so full that figures path around obstacles visibly, or the pods stop reading as
  the work areas.
- **Pixel art.** The room left pixel-drawn art on 2026-10-23; anything drawn in pixels now would clash
  (miley's call, nick agreed with the tool split below).

## How it gets made (decided)

The tool split, as proposed in the session and accepted by nick ("sounds good"):

| What | Made with | Why |
| --- | --- | --- |
| The five paintings | An image model, once, offline; committed as images | They are flat pictures; a model gives fine-art texture no script can |
| Frames, mats, plinths, rugs, the side table, shelves, books | Blender scripts (`scene.py`) | Structural pieces that must match the room's light; text that diffs |
| The three signs: oak boards, gold lettering, brass chains and lamps | Blender scripts (`scene.py`), wall fixtures like the frames | The lettering is modelled, so it catches the room's light; a DOM tag cannot |
| Sculptures, vases, the floor lamp, the nook armchair, magazine rack, coat stand | Meshy (ADR 755), finished in Blender with the room's matte materials | One-off organic shapes that are slow to model by hand |

The image model used for the brainstorm samples is **Z-Image-Turbo** (`Tongyi-MAI/Z-Image-Turbo`,
**Apache-2.0** licence, checked on the Hugging Face hub 2026-11-03). It runs through a hosted Space, an
art tool like Blender or Meshy; nothing generates at runtime.

## Constraints

- **Provenance, for every painting:**
  - The prompt describes a **subject and a technique only**. It never names an artist, a movement
    tied to one person, a title, a museum or "in the style of".
  - The prompt, the seed, the model and the date are **committed in a sidecar** beside the image, the
    same way Meshy records its props (`meshes/<name>.json`, ADR 755). A reviewer reads the sidecar.
  - Before it ships, each image is **checked by eye** for a resemblance to a famous work, a signature
    mark, lettering or a watermark. One that fails is cropped, if the mark is in a corner, or
    regenerated. One brainstorm sample already failed: the modernist piece had a fake signature bottom
    right.
  - **nick sees all five before they ship** (nick chose this, 2026-11-03): at full size and at room
    size, before the paintings PR merges. They ship only on his yes.
- **Size on screen.** A print shows at about 30–45 px on a normal viewport (`render.ts` notes). A
  painting must read at that size: a clear value structure and a strong silhouette, not fine detail.
  The still life is the riskiest of the four.
- **Light.** The paintings must sit in the room's light: dimmer and warmer in the evening, darker at
  night, under the same day states the room uses (`rendered/roomState.ts`). The new props are lit by
  the room's own rig, like every other prop.
- **The wall projection.** A print lies flat on a back wall, so it is drawn with that wall's skew, the
  way the motif is drawn today (`wallArt` in `render.ts`), not as a screen-aligned rectangle. **Trap:**
  on the back-left wall (four of the five frames) `+t` runs screen-left, so an image drawn through the
  same `wallPt` transform comes out mirrored. Today's motifs were chosen to survive that; a painting
  must be flipped back.
- **Bytes.** Office art is capped by `officeArtBytes` in `docs/perf/budgets.json`: **9,730,000 B, with
  9,623,782 B used** (2026-11-03), so about 106 KB is free. Five small paintings fit. The props
  (sprites per light state) and the re-rendered shelves almost certainly do not, so expect a
  deliberate raise, logged in `docs/perf/web-live-baseline.md` (ADR 151/183).
- **Walking paths.** No new piece may sit on a path or a seat's approach. The office already checks
  layout in `layout.test.ts`. New pieces join that check.
- **The signs are canvas art; the doors stay DOM.** Today the wiki and work-board signs are DOM tags
  (`.lc-boardspot__tag` in `Live.css`) and the settings tab is a DOM tab (`.lc-hoursspot__tab`),
  laid over the canvas by `index.ts` from `boardAnchor`/`shelfAnchor`. The new signs are rendered
  wall fixtures. The hotspot buttons stay, invisible over the rendered sign, keeping their accessible
  names, the hover glow, the 24px tap floor, and the red pending-pairing dot. The tap-target and
  contrast gates (`a11y:targets:check`, `a11y:check`) must stay green.
- **The new seat** joins the existing leisure system (`LEISURE_SPOTS`, `seating.ts`), not a new one.
- **Meshy** is used under ADR 755's rules: static props only, untextured, finished in Blender.

## miley's calls (made after the builder check; nick can overrule)

- **Floor lamps glow after dark.** Both new floor lamps (the nook's and the back-corner one) get a lit
  variant and a pool of light in the evening and night states, on whether or not anyone sits there.
  This follows the desk lamps (`desk_lamp`, `deskLampOn` in `lighting.ts`). An unlit lamp in a dark
  room would read as pasted on.
- **What is required and what is cut first.** Required: the five paintings, the books, the nook, and
  at least two of the three display pieces. Optional, cut first in this order if the floor or the
  bytes run out: the magazine rack, the coat stand, the second rug, the third display piece.
- **The nook seat's frequency.** One seat, weighted like any other leisure seat. It joins the
  interleaved `LEISURE_SPOTS` order so idle members spread out, not as a special favourite. Its zone
  name must not reuse "nook", which already means the break corner (`NOOK`, `{kind:'nook'}`).
- **The byte raise.** Raised and logged by the builder as usual (ADR 151/183). If the decor's total
  raise would pass **+1 MB**, the builder stops and asks nick before spending it.

## Left to the builder

- Which painting goes in which frame, and each painting's crop to its frame's aspect ratio. A sensible
  start: the impressionist landscape in the big left-corner frame, the colour field in the large
  right-wall frame, still life and modernist in the salon cluster, plus one more in either direction.
- Exact positions for the nook (within the back corner by the shelf) and the display pieces. The
  brainstorm marked candidate patches for the display pieces: the meeting table's open corner, the
  lounge edge, the back-left shelf.
- How the paintings are stored and drawn: an image per painting, or one small atlas; drawn with the
  wall's transform at runtime, or baked into the frame asset.
- How a painting follows the day states: a runtime tint, or one baked image per state.
- The book generator's parameters, as long as it gives every listed look and stays deterministic.
- Whether the image model's use needs an ADR of its own, like ADR 755 for Meshy. Probably yes: it is a
  new source of committed art. If so, it lands before the paintings do.
- How to cut this into increments. A natural split: (1) paintings, (2) the signs, (3) books, (4) floor
  pieces and the nook.
