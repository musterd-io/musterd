/**
 * A small drawing per role, worn at the front of the role tag on a nameplate (lane 01M5G33VH8; nick
 * picked "tag with a glyph" from four treatments shown side by side, 2026-10-21). One per role in the
 * library, keyed by the roster's own role id. A role without one keeps the plain tag; a glyph is
 * decoration beside the role's name, so it is hidden from assistive tech and the name carries the
 * meaning. Drawn on an 11-unit grid to sit on the 10px tag text; the tag tints it with the member's
 * hue (`.lc-gl-label__job svg` in Live.css).
 */
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';

const GLYPHS: Record<string, string> = {
  // A key: the admin role holds the team's governance.
  admin: `<circle cx="3.5" cy="5.5" r="2" ${STROKE}/><path d="M5.5 5.5h4M8 5.5v1.8M9.5 5.5v1.3" ${STROKE}/>`,
  // A parcel: the courier moves material between machines.
  courier: `<path d="M1.5 3.5 5.5 1.5l4 2v4l-4 2-4-2zM1.5 3.5l4 2 4-2M5.5 5.5v4" ${STROKE}/>`,
  // A pen nib.
  designer: `<path d="M2 9.5 3 6.5l4.5-4.5 2 2L5 8.5zM6.6 2.9l2 2" ${STROKE}/>`,
  // Angle brackets: code.
  engineer: `<path d="M3.5 3 1.2 5.5 3.5 8M7.5 3l2.3 2.5L7.5 8" ${STROKE}/>`,
  // A star: the one who started it.
  founder: '<path d="M5.5 1l1.3 2.8 3 .3-2.3 2 .7 3-2.7-1.6L2.8 9.1l.7-3-2.3-2 3-.3z" fill="currentColor"/>',
  // An eye: watches, holds no lanes.
  observer: `<path d="M1 5.5C2.5 3 4 2 5.5 2S8.5 3 10 5.5C8.5 8 7 9 5.5 9S2.5 8 1 5.5z" ${STROKE}/><circle cx="5.5" cy="5.5" r="1.3" fill="currentColor"/>`,
  // A folded map.
  planner: `<path d="M1.5 2.5 4 1.5l3 1 2.5-1v7L7 9.5l-3-1-2.5 1zM4 1.5v7M7 2.5v7" ${STROKE}/>`,
  // Two server units.
  platform: `<path d="M1.5 2h8v3h-8zM1.5 6h8v3h-8z" ${STROKE}/><circle cx="3.3" cy="3.5" r=".7" fill="currentColor"/><circle cx="3.3" cy="7.5" r=".7" fill="currentColor"/>`,
  // A megaphone: the product's voice.
  comms: `<path d="M1 4.2h2.2L6.8 1.8v8.4L3.2 7.8H1z" fill="currentColor"/><path d="M8.6 3.8a2.4 2.4 0 0 1 0 3.4" ${STROKE}/>`,
  // A flask.
  researcher: `<path d="M3.8 1.5h3.4M4.6 1.5v3L2 9a.9.9 0 0 0 .8 1.3h5.4A.9.9 0 0 0 9 9L6.4 4.5v-3" ${STROKE}/>`,
  // A shield.
  security: '<path d="M5.5 1 9.5 2.6v3c0 2.3-1.7 3.9-4 4.6-2.3-.7-4-2.3-4-4.6v-3z" fill="currentColor"/>',
  // A checklist: keeps the record honest.
  steward: `<path d="M1.5 2.5l1 1L4 2M5.5 3h4M1.5 7l1 1L4 6.5M5.5 7.5h4" ${STROKE}/>`,
};

// A team that took the built-in before ADR 699 renamed it still holds `product-communications`.
GLYPHS['product-communications'] = GLYPHS['comms']!;

/** The role's glyph as an inline `<svg>` string, or null when the role has none. */
export function roleGlyph(role: string): string | null {
  const id = role.trim().toLowerCase();
  if (!Object.hasOwn(GLYPHS, id)) return null;
  return `<svg viewBox="0 0 11 11" aria-hidden="true">${GLYPHS[id]}</svg>`;
}
