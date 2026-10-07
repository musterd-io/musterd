import type { StyleDialKey, StyleDialsWire, StyleFloorWire, StylePrefsWire } from '@musterd/protocol/wire';
import type { StylePolicyStored, TeamPolicyRead } from './client';

/**
 * The /board style sheet's merges (ADR 514 inc 5). Both routes REPLACE what they are sent — a
 * human's prefs whole, the team's sparse policy doc whole (ADR 185) — so every edit is a pure
 * "this doc, with one thing changed" and the sheet sends the result. Nothing here mutates.
 */

/** Set one of a human's dials, or (`null`) hand it back to the team default by dropping the key. */
export function withDial<K extends StyleDialKey>(
  prefs: StylePrefsWire,
  key: K,
  value: StyleDialsWire[K] | null,
): StylePrefsWire {
  const next = { ...prefs };
  if (value === null) delete next[key];
  else next[key] = value;
  return next;
}

/** A human's prose. Blank — whitespace only — means none, so the key goes. */
export function withProse(prefs: StylePrefsWire, text: string): StylePrefsWire {
  const next = { ...prefs };
  if (text.trim() === '') delete next.prose;
  else next.prose = text;
  return next;
}

export interface TeamStylePatch {
  floor?: Partial<StyleFloorWire>;
  defaults?: Partial<StyleDialsWire>;
  /** Blank removes the team prose. */
  prose?: string;
}

/**
 * Merge one admin edit into the stored policy doc, keeping every other key — a key left out of a
 * `POST /policy` resets to its default, which is the ADR 185 bug this exists not to repeat. A style
 * block left empty is dropped whole, so a cleared team is stored as "never set".
 */
export function withTeamStyle(
  stored: TeamPolicyRead['stored'],
  patch: TeamStylePatch,
): TeamPolicyRead['stored'] {
  const style: StylePolicyStored = { ...stored.style };
  if (patch.floor) style.floor = { ...style.floor, ...patch.floor };
  if (patch.defaults) style.defaults = { ...style.defaults, ...patch.defaults };
  if (patch.prose !== undefined) {
    if (patch.prose.trim() === '') delete style.prose;
    else style.prose = patch.prose;
  }
  const next = { ...stored };
  if (Object.keys(style).length === 0) delete next.style;
  else next.style = style;
  return next;
}

/**
 * Was this knob chosen for the team, or is it the shipped default? Presence in the sparse stored
 * doc is the whole answer (ADR 185): a knob an admin set to its shipped value still reads as set.
 */
export function teamKnobSet(
  stored: TeamPolicyRead['stored'],
  area: 'floor' | 'defaults' | 'prose',
  key?: string,
): boolean {
  const style = stored.style;
  if (!style) return false;
  if (area === 'prose') return style.prose !== undefined;
  const block = style[area] as Record<string, unknown> | undefined;
  return block !== undefined && key !== undefined && key in block;
}
