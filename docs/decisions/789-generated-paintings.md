# 789 — Generated paintings for the office walls

- Status: accepted
- Date: 2026-11-03

## Context

The office on /live has five framed pictures. Since lane 01M5D8EJ40 the frames and mats are rendered
in Blender, but the picture in each was a flat motif painted at runtime (arches, a Bauhaus square, a
cairn, a sunrise) at 68% of the opening. nick, 2026-11-03: the art "seems kind of too simplistic and the
art prints are smaller than the frames around them". He asked for paintings that are "not recognizable
… but looks like they could be fine art" (office decor refresh spec, 2026-11-03).

A picture is flat, so the tools the room already uses do not fit: a Blender script cannot paint an
oil-on-canvas surface, and Meshy (ADR 755) makes meshes. An image model can. The brainstorm tried
**Z-Image-Turbo** (`Tongyi-MAI/Z-Image-Turbo`, licence **Apache-2.0**, checked on the Hugging Face hub
2026-11-03) through a hosted Space: four samples, one per direction, and nick said "they all look
fantastic".

## Problem

A generated image is a binary, like a Meshy mesh: it does not diff and cannot be checked by reading
it. It also carries a risk a mesh does not: an image model can reproduce or closely echo an existing
artwork, or paint something that reads as a real artist's signature. nick: "make sure we are not
copying any actual art so we dont get in trouble legally".

## Decision

1. **An image model is an art source for flat pictures only**: the office paintings now, and nothing
   that is a mesh, a figure or UI. It runs offline as an art tool, like Blender and Meshy. Nothing at
   runtime calls it, and its outputs are committed.
2. **Every generated picture has a sidecar** beside its source in `packages/web/art/office/paintings/`
   (`<slot>-<slug>.json`): `prompt`, `seed`, `model`, `steps`, `shift`, `resolution`, `date`,
   `art_slot`, `source`, `check` and `approved_by`. The sidecar is what a reviewer reads.
3. **Prompts describe a subject and a technique only.** They never name an artist, a movement tied to
   one person, a title, a museum, or "in the style of".
4. **Each picture is checked by eye before it ships**, for a resemblance to a well-known work, a
   signature mark, lettering or a watermark. The result goes in `check`. A failing picture is cropped,
   when the mark sits at an edge, or regenerated.
5. **nick approves the set before it merges**, at full size and at room size. His approval is recorded
   in `approved_by`.
6. **The pipeline:** `art/office/paintings.py` (Pillow) crops each source to its frame's print opening
   and writes `office-art-painting-<slot>.webp` plus a `painting/<slot>` manifest entry. `paintings.ts`
   draws it onto the wall's plane over the rendered frame and multiplies the room's light tint
   (`figureTintFor`) over it, so it dims at dusk and night. The runtime motifs are deleted.

## Consequences

- The five paintings ship at ~18 KB in total (6 px per logical unit, WebP q85), inside the
  `officeArtBytes` headroom; no budget raise.
- The motif painter (`MOTIFS`, `INK`) is gone from `render.ts`, which pays for `paintings.ts` in the
  total-JS budget.
- Where the picture sits was measured, not assumed: the rendered mats sit ~2 units below `wallPt`'s
  centre (`PRINT_DROP`), and the picture is drawn just behind the frame's front face (`printDepth`).
  A re-render of the frames that moves them must re-measure.
- The mirror on the back-left wall applies to images too (`paintingQuad`'s `mirror`): a picture
  drawn through `wallPt` there would read backwards.
- nick approved the set on 2026-11-03 ("ship them and move the hills piece … none of the art should
  be on top of any window treatments"). The hills piece (slot 3) had hung behind the front door's
  frame, out of sight; the wildflowers and the colour field each overlapped a drape. The three small
  pieces now hang in a row above the door, and the colour field in the right wall's corner.
  `layout.test.ts` holds the new rules: no picture inside a window's drape reach (`DRAPE_REACH`), none
  behind the door.
- If the image model's licence or availability changes, the committed sources and sidecars still
  stand; a new picture would need a model that passes the same licence check.

## Observability & Evaluation

- **Traces:** n/a — no agent-facing behaviour; the pictures are static art.
- **Eval:** nick's review of the set at full size and room size, recorded per picture in
  `approved_by`; the per-picture provenance `check` in each sidecar.
- **Experiment:** n/a — a one-time art change, judged by eye; there is no metric to move.
