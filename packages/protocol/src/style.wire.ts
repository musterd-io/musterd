/**
 * Agent style (ADR 514) without a validator — the dial vocabularies, the prose cap and the pure
 * reads every surface shares. `style.ts` builds the zod schemas from these tuples; the browser
 * (`/board`'s "how agents talk to me" sheet) reads this module through `@musterd/protocol/wire`, so
 * a dial picker costs no zod and no `node:crypto` (the epoch hash stays in `style.ts`).
 */

export const STYLE_PUSHBACK = ['every-time', 'when-it-matters', 'only-on-risk'] as const;
export const STYLE_BLUNTNESS = ['direct', 'plain', 'soft'] as const;
export const STYLE_LENGTH = ['concise', 'normal', 'thorough'] as const;
export const STYLE_FORMAT = ['prose', 'structured'] as const;

/** The prose cap, team and human alike (spec §4.1). Inclusive: five lines pass, six are refused. */
export const STYLE_PROSE_MAX_LINES = 5;
/** The character cap that makes the line cap a size bound: five lines of ~160 characters. */
export const STYLE_PROSE_MAX_CHARS = 800;

/** The four dials, in the order every surface lists them. */
export const STYLE_DIAL_KEYS = ['pushback', 'bluntness', 'length', 'format'] as const;
export type StyleDialKey = (typeof STYLE_DIAL_KEYS)[number];

/** Each dial's closed set, by key — what a picker iterates. */
export const STYLE_DIAL_VALUES = {
  pushback: STYLE_PUSHBACK,
  bluntness: STYLE_BLUNTNESS,
  length: STYLE_LENGTH,
  format: STYLE_FORMAT,
} as const satisfies Record<StyleDialKey, readonly string[]>;

/** The four dials resolved — the shape `StyleDialsSchema` parses to. */
export interface StyleDialsWire {
  pushback: (typeof STYLE_PUSHBACK)[number];
  bluntness: (typeof STYLE_BLUNTNESS)[number];
  length: (typeof STYLE_LENGTH)[number];
  format: (typeof STYLE_FORMAT)[number];
}

/** The team floor resolved — the shape `StyleFloorSchema` parses to. */
export interface StyleFloorWire {
  assess_before_agreeing: boolean;
  disagree_once_then_commit: boolean;
  concession_names_check: boolean;
  human_critique_weighed_as_peer: boolean;
}

/** A human's own dials as stored — every key optional; unset means the team default. */
export type StylePrefsWire = Partial<StyleDialsWire> & { prose?: string };

/** `length normal → thorough`, one entry per dial that moved, in dial order; '' when none did. */
export function describeDialChange(from: StyleDialsWire, to: StyleDialsWire): string {
  return STYLE_DIAL_KEYS.filter((k) => from[k] !== to[k])
    .map((k) => `${k} ${from[k]} → ${to[k]}`)
    .join(', ');
}

/** Every line break a model would read as one: CRLF, LF, lone CR, VT, FF, NEL, LS, PS. */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/g;

/** Lines in a prose addendum. A trailing line break is not a line; every break form counts alike. */
export function styleProseLineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(LINE_BREAK, '\n').replace(/\n$/, '').split('\n').length;
}

/** Null when the prose fits; otherwise the refusal a surface prints, naming the count and the cap. */
export function styleProseProblem(text: string): string | null {
  const lines = styleProseLineCount(text);
  if (lines > STYLE_PROSE_MAX_LINES)
    return `prose is ${lines} lines; the cap is ${STYLE_PROSE_MAX_LINES}`;
  if (text.length > STYLE_PROSE_MAX_CHARS)
    return `prose is ${text.length} characters; the cap is ${STYLE_PROSE_MAX_CHARS}`;
  return null;
}

const PUSHBACK_WORDS: Record<StyleDialsWire['pushback'], string> = {
  'every-time': 'pushback every time',
  'when-it-matters': 'pushback when it matters',
  'only-on-risk': 'pushback only on risk',
};

/** The four dials as one line: `pushback when it matters · plain · normal · prose`. */
export function describeDials(dials: StyleDialsWire): string {
  return [PUSHBACK_WORDS[dials.pushback], dials.bluntness, dials.length, dials.format].join(' · ');
}

/** One phrase per floor boolean, in the order the spec lists them (§4.2) — the block's own words. */
export const STYLE_FLOOR_PHRASES: ReadonlyArray<readonly [keyof StyleFloorWire, string]> = [
  ['assess_before_agreeing', 'assess before you agree; no praise before a check'],
  ['disagree_once_then_commit', 'disagree once, with the reason, then follow the decision'],
  ['concession_names_check', 'a concession names what you checked'],
  ['human_critique_weighed_as_peer', "weigh a human's critique by its evidence, like anyone's"],
];
