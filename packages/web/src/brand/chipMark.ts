/**
 * The musterd mark, as data — a split `m` with a seat at the foot of each stem, in a white ring on a
 * gold glass tile (ADR 702, superseding the ADR 497 hand-drawn `m` and the ADR 154 chip).
 *
 * It lives here rather than inside `MusterdWord.tsx` because two very different renderers need the
 * same mark and only one of them is React. The office scene builds raw DOM in a lazily-loaded chunk
 * (`office-scene/index.ts`), and importing a `.tsx` component to reach a path string would drag
 * React's component into that chunk to get at a constant — the packages/web perf contract's exact
 * objection. So the geometry is a plain module both sides import, and `MusterdWord.tsx` renders it
 * as JSX while `musterdChipSvg` renders it as markup.
 *
 * Only the **small cut** lives in code. At 13–18px the 80-unit strokes and 50-unit seats would fill
 * in the cuts between the stems, so the small cut thickens neither by much: `CHIP_SMALL_EXTRA` is
 * added to the stroke and `CHIP_SMALL_DOT_EXTRA` to the seat radius, which is what holds the cuts
 * open. The full-size cuts are files in `docs/design/assets/` (`chip.svg` solid, `chip-glass.svg`
 * glass) and share this module's geometry (`chipMark.test.ts` pins it).
 *
 * The code renderer draws the glass tile as a translucent gradient over whatever is behind it. The
 * backdrop blur that completes the glass is a CSS property, so it belongs to the surface that wraps
 * the mark (the topbar), not to the mark — and the platforms that cannot blur (favicon, avatar,
 * README, MCP icon) use the solid files instead.
 */

/** The ink: strokes and seats. Cool slate, not the old zinc-900. */
export const CHIP_FG = '#2E3647';
/** Solid tile for surfaces that give the mark a flat ground (`chip.svg`). Pastel apricot. */
export const CHIP_SOLID_BG = '#F9DDA0';
/** Glass tile stops: gold at the top-left, fading to near-clear (`chip-glass.svg`). */
export const CHIP_GLASS_FROM = { color: '#EBAF14', opacity: 0.7 };
export const CHIP_GLASS_TO = { color: '#FFEBA0', opacity: 0.22 };
/** Corner radius on the 1024 viewBox (30%). */
export const CHIP_RADIUS = 307;
export const CHIP_VIEWBOX = 1024;
/** The white ring: a rounded square stroke, centred on the tile. 48 wide, so the m can fill the tile. */
export const CHIP_RING = { x: 83, size: 858, radius: 218, stroke: 48 };
/** Stroke of the `m`, and the seat radius, in viewBox units. */
export const CHIP_STROKE = 80;
export const CHIP_DOT_RADIUS = 50;
/** What the small cut adds to each so the cuts between the stems stay open. */
export const CHIP_SMALL_EXTRA = 26;
export const CHIP_SMALL_DOT_EXTRA = 13;
/** Where the seats sit: the foot of each stem. */
export const CHIP_DOTS = [
  [295, 660],
  [512, 660],
  [729, 660],
] as const;
/**
 * The `m`: the left stem runs into the first shoulder, the second shoulder starts where the first
 * lands, and the second and third stems stop short of their shoulders (the thin cuts). Soft corners
 * on the shoulders; round caps and joins come from the stroke, not the path.
 */
export const CHIP_GLYPH_PATH =
  'M295 660V416M295 416L347 364Q360 354 381 354H426Q447 354 460 364L512 416M512 416L564 364Q577 354 598 354H643Q664 354 677 364L729 416M512 660V530M729 660V530';

/**
 * The mark as an SVG string, for renderers that build markup rather than elements — the small
 * glass cut.
 *
 * `aria-hidden` is baked in: every place this is used, the word "musterd" is already present as
 * text beside it, so the mark is decoration and announcing it would make a screen reader say the
 * product name twice.
 */
export function musterdChipSvg(size: number): string {
  const stroke = CHIP_STROKE + CHIP_SMALL_EXTRA;
  const r = CHIP_DOT_RADIUS + CHIP_SMALL_DOT_EXTRA;
  const dots = CHIP_DOTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${CHIP_FG}"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHIP_VIEWBOX} ${CHIP_VIEWBOX}" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `<defs><linearGradient id="musterd-chip-g" gradientUnits="userSpaceOnUse" x1="300" y1="0" x2="720" y2="${CHIP_VIEWBOX}">` +
    `<stop offset="0" stop-color="${CHIP_GLASS_FROM.color}" stop-opacity="${CHIP_GLASS_FROM.opacity}"/>` +
    `<stop offset="1" stop-color="${CHIP_GLASS_TO.color}" stop-opacity="${CHIP_GLASS_TO.opacity}"/></linearGradient></defs>` +
    `<rect width="${CHIP_VIEWBOX}" height="${CHIP_VIEWBOX}" rx="${CHIP_RADIUS}" fill="url(#musterd-chip-g)"/>` +
    `<rect x="4" y="4" width="1016" height="1016" rx="303" fill="none" stroke="#fff" stroke-opacity=".65" stroke-width="8"/>` +
    `<rect x="${CHIP_RING.x}" y="${CHIP_RING.x}" width="${CHIP_RING.size}" height="${CHIP_RING.size}" rx="${CHIP_RING.radius}" fill="none" stroke="#fff" stroke-width="${CHIP_RING.stroke}"/>` +
    `<path d="${CHIP_GLYPH_PATH}" fill="none" stroke="${CHIP_FG}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>` +
    dots +
    `</svg>`
  );
}
