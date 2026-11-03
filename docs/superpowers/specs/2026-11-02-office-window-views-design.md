# Office window views — a world outside the windows

**Date:** 2026-11-02 · **Owner:** miley (designer) · **Asked by:** nick · **Status:** built 2026-11-03

Brainstorm mockups: `docs/design/assets/window-views/window-views.html` (three settings side by side) and
`window-views-v2.html` (one wall, two windows, one city panorama — the reference).

## Intent

The office's windows today are glowing panes baked into the room shell (`room/light-<state>`): light,
not a place. nick (2026-11-02): make them "magical, warm, fun, beautiful, delightful, polished" — a
view outside that changes, is fun and warm, with window treatments that look real. The windows are
where the eye rests between events; this is the room's biggest unspent delight.

## Goals

- Every window on both back walls looks onto **one panorama**: the office is in one place, and each
  window sees its own slice of it.
- The viewer picks the place from three **settings**: `city`, `coast`, `mountain`. Per viewer, in the
  browser; `/broadcast` shows the team default (`city`).
- The outside lives on the **clock and the weather the room already has**: dawn, day, golden hour,
  dusk, night at Los Angeles time (`pstNowHours`), and clear / cloudy / rain / snow from Open-Meteo
  (`weather.ts`, lane 01M5XS6597). No new setting, no new network path.
- The plates look like the room does since 2026-10-23: **rendered**, lit faces and shadow faces, haze
  with distance, soft sun — not drawn pixels. nick, on the v1 mockup: "blocky / not 3D-ish like the
  updates we made when we moved from pixel-drawn to Blender".
- **Window treatments** rendered with the room so their light matches: terracotta drapes with
  tiebacks on every window, one treatment for the whole office (miley's call; nick saw it on v2 and
  said "looks good").
- Life on top: a thin sprite layer that makes the view breathe, with one or two signature movers per
  setting.

## Non-goals

- A per-window or per-team setting. One pick per viewer; one panorama per office.
- Parallax. The room does not pan (the fit is static; the drift tier is not a pan), so the view
  is fixed to its window. Revisit if a pan ever lands.
- `?office=painted` (the pre-2026-10-23 drawn walls) keeps its drawn panes; views are for the
  rendered shell only.
- Weather beyond the four states the room knows. Thunder, fog, wind are not states.
- Seasons, holidays, time-lapse controls. The `?light=HH` and `?weather=` dev overrides already exist
  and must keep working on the new layer.
- Anything 3D at runtime. Blender stays an art tool (hard rule 6 untouched).

## Anti-goals (a failure even if it works)

- The windows become the loudest thing in the room. Movers are rare and slow; nothing outside ever
  competes with a seat's speech bubble or an ask.
- The frame budget or the art budget quietly grows. The plates are the size of three shell renders;
  the sprites are dozens of pixels. ADR 151 is the seatbelt.
- A blank or wrong window when a fetch fails. No forecast → last known, else clear; a missing plate →
  today's glowing pane.

## The experience

**At rest, by day.** Through each window: sky, a far row in haze, a near row with lit and shadow faces,
a sun whose height follows the hour. Clouds drift, slowly. The light pool on the floor under each
window (already in the shell's item rig) stays. The drapes hang open, tied back.

**Golden hour → dusk → night.** The sky runs the clock's colour curve; the plate crossfades day →
evening → night over the same 45-minute edges `lighting.ts` already uses (07:00, 16:30, 19:00).
Windows light up across the city one by one; the lighthouse starts blinking; the cabin glows. The
glass picks up a faint reflection of the room's own lamps. Stars come out; a moon crosses.

**Weather.** `cloudy` thickens the haze and dims the sun; `rain` streaks the glass and darkens the
plate a step; `snow` drifts past and the plate goes a step paler and bluer. Weather is a runtime tint
and a sprite set, never a plate variant: there are no weather plates. The sprites of a state (rain
streaks, snow) replace the clear-sky movers (birds, plane) while it holds.

**The movers.** Per setting, rare and slow, never more than one on screen per window:

| setting    | always                             | signature                                       |
| ---------- | ---------------------------------- | ----------------------------------------------- |
| `city`     | clouds, sun/moon, stars, lit windows | a tram every few minutes; a plane with a contrail at dusk |
| `coast`    | clouds, sun/moon, stars, sea shimmer | a sailboat crossing; gulls; a lighthouse that blinks after dark |
| `mountain` | clouds, sun/moon, stars, cloud shadows | a hawk circling high; one cabin whose windows glow at night |

**The chooser.** In the office menu (where `?office=painted` and still mode live): "Outside: City ·
Coast · Mountain". The pick is `localStorage` (`office.view`), read at scene start, applied on change
without a reload. `/broadcast` ignores it and shows `city`. The glass gradient and the frame's inner
shadow are what make the window read as a hole, not a sticker.

**Still mode** (`?still`, ADR 285): sprites freeze, the clock still paints the correct state.

## How it is made

Mirrors the room (spec 2026-10-20 office realism; `packages/web/art/office/README.md`).

1. **Shell change (one render).** `scene.py`'s `window-pane` material becomes **transparent** (alpha
   0) in the `room/light-*` renders. The frames, mullions and sills stay in the shell, and so do
   the window spots that pool light on the floor and the beams and motes `render.ts` draws: the
   light the windows give the room is unchanged. The **drapes** are new geometry in the shell: a
   rod above each frame and two tied-back panels hung **on the wall beside the frame, not over the
   glass**, so the visible pane rect in `WINDOWS` is unchanged and nothing downstream (pools, nap
   spots) moves. Rendered with the room in every day state so their light matches.
2. **Exterior scenes (`exterior.py`, new).** One Blender scene per setting: low-poly, under the shell's
   own `LIGHT_STATES` rig so the sun angle and colour match the room's. Meshy (`meshy.py`) is fine
   for buildings, trees, a boat; hand-placed. The two back walls face 90° apart, so one scene is
   rendered through **two orthographic cameras**, one looking out of each wall, each framed to that
   wall's window span with a small margin: the same city seen from two sides of the corner. The
   plates hold **land only** — buildings, sea, hills — on a transparent sky, with **no sun or moon
   disc**: the sky is a runtime gradient on the continuous clock, and the discs are sprites, so the
   hour moves every minute while the land's lit faces crossfade at the three states. Output
   `view/<setting>-<wall>-<day|evening|night>.webp` (3 × 2 × 3 = 18 plates), same pngquant → WebP
   path, listed in `manifest.json` with anchor and px-per-unit, cropped to the window span.
3. **Runtime (`windowView.ts`, new).** Draws under the shell, before `drawWalls`: for each window
   rect (from `WINDOWS` in `scene.py`, carried in the manifest), clip to the pane, paint the sky
   gradient for the hour, blit the two nearest land plates crossfaded by the clock, then the sprite
   layer, then the glass (a 6% white diagonal gradient; at night a lamp reflection at 10%). Weather
   is a tint and a sprite set on the same clip, read from `weather.ts`'s current state. This
   **replaces** `render.ts`'s pane painting — `glassColor()` and the per-pane rain and snow of lane
   01M5XS6597 — which is deleted with its tests; the beams and motes stay. When the art set has no
   plates (an older manifest), the pane is painted with `glassColor()` as today, so a stale bundle
   never shows a hole.
4. **Sprites (`windowSprites.ts`, new).** Tiny canvas-drawn or pixel-art movers, seeded by
   `ambientSeed` so every viewer sees the same tram at the same time. Each mover is a function of
   `(now, seed)` → position or null; nothing allocates per frame.
5. **The chooser** in the office menu; the preference module beside the other office prefs.
6. **Dev overrides** `?view=city|coast|mountain` added next to `?light` and `?weather`.

Budgets: `officeArtBytes` has ~65 KB of headroom today (8,835,072 B of 8,900,000). The 18 plates
are window-span crops on transparent sky, estimated ≤ 400 KB after quantize + WebP, plus the
re-rendered shell with drapes. The raise is the designer's to make and log (`docs/perf/budgets.json`
`$comment` + `docs/perf/web-live-baseline.md`, ADR 151/183), one entry per increment that adds art. Frame cost: one extra clipped blit per
window (four windows) and a few sprite draws; measured in CI's perf gate, not locally.

## Increments (each its own lane; the plan cites them)

1. **Shell cut + city** (lane `01M6ENGW2H25MYV40Z2TPWBNJB`). Transparent panes, drapes in the shell, `exterior.py` with the city scene,
   the two-camera plate pipeline with only city rendered, `windowView.ts` with clock crossfade, weather overlay,
   parallax, glass. No chooser; `?view=` override only. Ships behind nothing: city is the default.
2. **Coast and mountain** (lane `01M6ENH3T54EPSBRM1RNZXBM9S`). Two more scenes, their plates, their signature movers.
3. **Chooser + polish** (lane `01M6ENHBPBSTJJZNA21Y0NBJR4`). The office-menu picker, `localStorage`, broadcast default, the lamp
   reflection at night, sprite seeding review, committed mockups, spec marked built.

_(Built 2026-11-03, lane 01M6ENHBPBSTJJZNA21Y0NBJR4: the three lanes above shipped as #3731, #3740 and
increment 3's PR. Increment 3 as built: the "Outside" button beside the sound toggle (no office menu
exists), `?view=` > the pref > city, /broadcast always the city; only the chosen view's plates load, and a
change fetches the new plates before the panes swap; the lamp reflection after dusk; a horizon haze band
per pane for depth, thicker in cloud, snow and rain; the night sky's cache key now steps hourly; rain and
snow hide the moon and stars, cloud hides the stars, and clouds shade toward slate at night. Not done:
art-side depth (a nearer foreground silhouette, stronger lit/shadow faces, a per-wall camera yaw) and
denser lit windows on the night plates — both need a re-render inside the art budget's last ~0.1 MB, and
nick called the windows good for now.)_

## Calls made after the builder check (miley, 2026-11-02)

_(Corrected 2026-11-02 while planning, lane 01M6ENGW2H25MYV40Z2TPWBNJB: `?office=painted` was deleted on
2026-10-23, so there is no painted mode to preserve; there is no office menu, so the chooser sits beside
the sound toggle on /live; `glassColor()` had no callers and is deleted; the per-pane rain and snow of
`drawWeather` (lane 01M5XS6597) is kept as the weather sprite layer, not replaced.)_

- Two cameras, one per wall; 18 plates, land only, sky and discs at runtime.
- Weather is tint + sprites, never a plate variant.
- No parallax: there is no pan to parallax against.
- Drapes hang beside the glass; the pane rect and the floor light are untouched.
- The new layer replaces the old pane painting; painted mode is unchanged.
- The art-budget raise is the designer's, logged per increment.

## What is left to the builder

- The exterior camera's exact framing and the plate crop margins.
- The sprite drawing style (canvas primitives vs. a tiny sprite sheet); either, under the budget.
- Exact haze/dim curves per weather state; the mockup's numbers are a starting point.
- Whether the drapes get a second variant (drawn) for night; default is one, open.

## Open questions

None blocking. Weather was the one nick-only call: **wire it in from day one** (nick, 2026-11-02).
