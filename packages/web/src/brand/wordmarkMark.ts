/**
 * The musterd wordmark, as data: the word set on a sand nameplate with a white ring and a mustard
 * edge (ADR 704). Every letter is drawn, none is typeset, so the mark never depends on a font.
 *
 * The letters follow the m of the tile mark (ADR 702): flat tops and bottoms with chamfered
 * corners, one 74-unit round-capped stroke, a round seat at each stem foot, and a spark where the
 * m's stems stop short of their shoulders. The plate repeats the tile's construction (sand ground,
 * white ring) so the two read as one family.
 *
 * Same split as `chipMark.ts`: a plain module, because the office scene builds DOM in a lazy chunk
 * and cannot import a component, and `MusterdWord.tsx` renders it as JSX. `wordmark.svg` (here and
 * in `docs/design/assets/`) is the file form; `wordmarkMark.test.ts` pins module and files together.
 * One cut only: the strokes are heavy enough to hold at 24px tall and the mark is not meant to be
 * smaller than that.
 */

export const WORDMARK_BOX = { x: 135, y: 80, w: 2987, h: 736 };
/** Width over height, for sizing the box from a height. */
export const WORDMARK_ASPECT = 2987 / 736;
export const WORDMARK_PLATE = '#EBD9A0';
/** Mustard edge of the plate (the brand accent). */
export const WORDMARK_RIM = '#E1AD01';
/** The letters, the m and the seats. */
export const WORDMARK_INK = '#1F6F6B';
/** The sparks in the m's cuts: mustard-700, the ramp's value for marks on light. */
export const WORDMARK_SPARK = '#B8860B';
export const WORDMARK_STROKE = 74;
export const WORDMARK_SEAT_RADIUS = 46;
export const WORDMARK_SPARK_RADIUS = 18;
/** Seats: the foot of each stem (m, then u, r, d). */
export const WORDMARK_SEATS = [[295, 660], [512, 660], [729, 660], [1139, 660], [2414, 660], [2956, 660]] as const;
export const WORDMARK_SPARKS = [[512, 473], [729, 473]] as const;
/** The m, u, s, t, e, r and d as one stroked path (round caps and joins come from the stroke). */
export const WORDMARK_PATH =
  'M295 660V416M295 416L347 364Q360 354 381 354H426Q447 354 460 364L512 416M512 416L564 364Q577 354 598 354H643Q664 354 677 364L729 416M512 660V530M729 660V530 M889 354 V596 L953 660 H1139 M1139 354 V660 M1555 418 L1491 354 H1369 L1305 418 V475 L1341 507 H1519 L1555 539 V596 L1491 660 H1369 L1305 596 M1749 290 V596 L1813 660 H1854 M1699 354 H1844 M1998 507 H2248 M2248 507 V418 L2184 354 H2062 L1998 418 V596 L2062 660 H2184 M2414 354 V660 M2414 418 L2478 354 H2549 M2956 354 H2770 L2706 418 V596 L2770 660 H2956 M2956 235 V660';

/** The wordmark as an SVG string, for renderers that build markup rather than elements. */
export function musterdWordmarkSvg(height: number): string {
  const { x, y, w, h } = WORDMARK_BOX;
  const seats = WORDMARK_SEATS.map(
    ([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="${WORDMARK_SEAT_RADIUS}" fill="${WORDMARK_INK}"/>`,
  ).join('');
  const sparks = WORDMARK_SPARKS.map(
    ([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="${WORDMARK_SPARK_RADIUS}" fill="${WORDMARK_SPARK}"/>`,
  ).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(height * WORDMARK_ASPECT)}" height="${height}" role="img" aria-label="musterd">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="160" fill="${WORDMARK_PLATE}"/>` +
    `<rect x="${x + 11}" y="${y + 11}" width="${w - 22}" height="${h - 22}" rx="149" fill="none" stroke="${WORDMARK_RIM}" stroke-width="22"/>` +
    `<rect x="${x + 46}" y="${y + 46}" width="${w - 92}" height="${h - 92}" rx="116" fill="none" stroke="#fff" stroke-width="30"/>` +
    `<path d="${WORDMARK_PATH}" fill="none" stroke="${WORDMARK_INK}" stroke-width="${WORDMARK_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>` +
    seats +
    sparks +
    `</svg>`
  );
}
