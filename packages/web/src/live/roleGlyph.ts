/**
 * A small picture per role, worn at the front of the role tag on a nameplate. Each is a picture of the
 * job that cannot be read as a state: nothing that looks like audio, a notification or a warning. nick,
 * 2026-10-21, on the first set (#3133): the comms speaker read as "that member's audio is on". This
 * set was redrawn as one family on a 16-unit grid and nick picked the two-tone style from a side-by-side
 * sheet (lane 01M5GCMN2S): a soft fill in the member's hue under a dark outline (`.lc-gl-label__job svg`
 * in Live.css holds the colours and stroke, so these strings carry shape only).
 *
 * Keyed by the roster's own role id. A role without one keeps the plain tag. A glyph is decoration
 * beside the role's name, so it is hidden from assistive tech and the name carries the meaning.
 * `class="b"` marks the silhouette (filled), `class="d"` a dot; an unclassed path is detail line.
 */
const GLYPHS: Record<string, string> = {
  // A key: the team’s governance.
  admin:
    '<path class="b" d="M5.3 4.8a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z"/><path d="M8.5 8h6 M12.2 8v2.3 M14.3 8v1.7"/><circle class="d" cx="5.3" cy="8" r="0.9"/>',
  // A paper plane: the word, sent out.
  comms:
    '<path class="b" d="M1.6 7.4 14.4 1.6 10.6 14.4 7.7 9.4Z"/><path d="M14.4 1.6 7.7 9.4 M7.7 9.4 7.2 13.2 9 11.2"/>',
  // A parcel: moves things between machines.
  courier:
    '<path class="b" d="M2 4.9 8 2.1l6 2.8v6.3L8 14.1l-6-2.9Z"/><path d="M2 4.9 8 7.7l6-2.8 M8 7.7v6.4 M5 3.5l6 2.8"/>',
  // A palette: colour and form.
  designer:
    '<path class="b" d="M8 1.7c3.6 0 6.3 2.4 6.3 5.4 0 2.1-1.5 3-3.1 3h-1.2c-.8 0-1.4.6-1.4 1.3 0 .4.2.7.4 1 .3.3.4.6.4 1 0 .8-.7 1.3-1.4 1.3-3.6 0-6.3-2.9-6.3-6.5S4.4 1.7 8 1.7Z"/><circle class="d" cx="5" cy="7" r="1.15"/><circle class="d" cx="7.9" cy="4.6" r="1.15"/><circle class="d" cx="11" cy="6.4" r="1.15"/>',
  // A code tile: </> builds the product.
  engineer:
    '<path class="b" d="M3.4 1.8h9.2a1.6 1.6 0 0 1 1.6 1.6v9.2a1.6 1.6 0 0 1-1.6 1.6H3.4a1.6 1.6 0 0 1-1.6-1.6V3.4a1.6 1.6 0 0 1 1.6-1.6Z"/><path d="M6.1 5.6 3.9 8l2.2 2.4 M9.9 5.6 12.1 8l-2.2 2.4 M8.9 4.8 7.1 11.2"/>',
  // A sprout: the one who planted it.
  founder:
    '<path class="b" d="M8 8.6C8 5.7 5.9 4 2.9 4c0 2.9 2.1 4.6 5.1 4.6Z"/><path class="b" d="M8 7.1c0-3 2.1-4.7 5.1-4.7 0 3-2.1 4.7-5.1 4.7Z"/><path d="M8 14.3V6.8 M4.6 14.3h6.8"/>',
  // Binoculars: watches from the side.
  observer:
    '<path class="b" d="M4.6 7.6a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8Z"/><path class="b" d="M11.4 7.6a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8Z"/><path d="M3 9V4.2h3V9 M10 9V4.2h3V9 M7.5 9.8h1"/>',
  // A folded map: where we are going.
  planner:
    '<path class="b" d="M1.8 3.6 5.6 2.1l4.8 1.6 3.8-1.5v10.3l-3.8 1.5-4.8-1.6-3.8 1.5Z"/><path d="M5.6 2.1v10.3 M10.4 3.7V14"/><circle class="d" cx="12.3" cy="6.4" r="1.1"/>',
  // Stacked layers: what everything runs on.
  platform:
    '<path class="b" d="M8 1.7 14.3 5 8 8.3 1.7 5Z"/><path d="M1.7 8.2 8 11.5l6.3-3.3 M1.7 11.4 8 14.7l6.3-3.3"/>',
  // A bubbling flask: experiments.
  researcher:
    '<path class="b" d="M6.4 1.8h3.2v4.3l3.9 6.4a1.3 1.3 0 0 1-1.1 2H3.6a1.3 1.3 0 0 1-1.1-2l3.9-6.4Z"/><path d="M5.4 1.8h5.2 M4.4 10.4h7.2"/><circle class="d" cx="7" cy="12.3" r="0.8"/><circle class="d" cx="9.6" cy="11.9" r="0.6"/>',
  // A shield with a check: kept safe.
  security:
    '<path class="b" d="M8 1.5 13.6 3.6v4.1c0 3.3-2.4 5.7-5.6 6.9-3.2-1.2-5.6-3.6-5.6-6.9V3.6Z"/><path d="M5.4 8.1l1.9 1.9 3.4-3.6"/>',
  // A checked clipboard: keeps the record honest.
  steward:
    '<path class="b" d="M4.2 2.8h7.6a1.2 1.2 0 0 1 1.2 1.2v9.3a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 13.3V4a1.2 1.2 0 0 1 1.2-1.2Z"/><path d="M6.2 1.7h3.6v2.3H6.2Z M5.6 9.2l1.7 1.7 3.2-3.4"/>',
};

// A team that took the built-in before ADR 699 renamed it still holds `product-communications`.
GLYPHS['product-communications'] = GLYPHS['comms']!;

/** The role's glyph as an inline `<svg>` string, or null when the role has none. */
export function roleGlyph(role: string): string | null {
  const id = role.trim().toLowerCase();
  if (!Object.hasOwn(GLYPHS, id)) return null;
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${GLYPHS[id]}</svg>`;
}
