import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Agent style (ADR 514; spec docs/superpowers/specs/2026-10-05-agent-style-design.md) — how a seat
 * talks to humans. Two layers: the **floor** and **team defaults** are team policy human admins own
 * (`PolicySchema.style`, sparse on write per ADR 185); a human's own **dials** and **prose**
 * (`members.style_prefs`) sit on top and can never lower the floor. Everything here is pure: the
 * daemon passes policy and prefs in, {@link resolveStyle} answers, {@link renderStyleBlock} prints
 * the block a seat reads on `team_join`.
 */

export const STYLE_PUSHBACK = ['every-time', 'when-it-matters', 'only-on-risk'] as const;
export const STYLE_BLUNTNESS = ['direct', 'plain', 'soft'] as const;
export const STYLE_LENGTH = ['concise', 'normal', 'thorough'] as const;
export const STYLE_FORMAT = ['prose', 'structured'] as const;

/** The prose cap, team and human alike (spec §4.1). Inclusive: five lines pass, six are refused. */
export const STYLE_PROSE_MAX_LINES = 5;

/** Lines in a prose addendum. A trailing newline is not a line; CRLF counts like LF. */
export function styleProseLineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
}

/** Null when the prose fits; otherwise the refusal a surface prints, naming the count and the cap. */
export function styleProseProblem(text: string): string | null {
  const n = styleProseLineCount(text);
  return n > STYLE_PROSE_MAX_LINES ? `prose is ${n} lines; the cap is ${STYLE_PROSE_MAX_LINES}` : null;
}

const ProseSchema = z
  .string()
  .max(2000)
  .refine((s) => styleProseProblem(s) === null, {
    message: `prose is at most ${STYLE_PROSE_MAX_LINES} lines`,
  });

/** The team floor: stance rules a preference cannot lower. An admin may turn one off (audited). */
export const StyleFloorSchema = z.object({
  assess_before_agreeing: z.boolean().default(true),
  disagree_once_then_commit: z.boolean().default(true),
  concession_names_check: z.boolean().default(true),
  human_critique_weighed_as_peer: z.boolean().default(true),
});
export type StyleFloor = z.infer<typeof StyleFloorSchema>;

/** The four dials. Team defaults carry every one; a human's prefs name only the ones they set. */
export const StyleDialsSchema = z.object({
  pushback: z.enum(STYLE_PUSHBACK).default('when-it-matters'),
  bluntness: z.enum(STYLE_BLUNTNESS).default('plain'),
  length: z.enum(STYLE_LENGTH).default('normal'),
  format: z.enum(STYLE_FORMAT).default('prose'),
});
export type StyleDials = z.infer<typeof StyleDialsSchema>;

/** `PolicySchema.style`, dense on read: `parse({})` is the shipped default. */
export const StylePolicySchema = z.object({
  floor: StyleFloorSchema.default({}),
  defaults: StyleDialsSchema.default({}),
  prose: ProseSchema.default(''),
});
export type StylePolicy = z.infer<typeof StylePolicySchema>;

/** What an admin wrote (ADR 185): optional at every level, so a present `floor` stays sparse. */
export const StylePolicyOverrideSchema = z.object({
  floor: StyleFloorSchema.partial().optional(),
  defaults: StyleDialsSchema.partial().optional(),
  prose: ProseSchema.optional(),
});
export type StylePolicyOverride = z.infer<typeof StylePolicyOverrideSchema>;

/** A human's own dials (`members.style_prefs`). Strict: the floor is not a preference. */
export const StylePrefsSchema = z
  .object({
    pushback: z.enum(STYLE_PUSHBACK).optional(),
    bluntness: z.enum(STYLE_BLUNTNESS).optional(),
    length: z.enum(STYLE_LENGTH).optional(),
    format: z.enum(STYLE_FORMAT).optional(),
    prose: ProseSchema.optional(),
  })
  .strict();
export type StylePrefs = z.infer<typeof StylePrefsSchema>;

/** One human's resolved style: the floor (team's), each dial (theirs, else the team's), both proses. */
export interface ResolvedStyle {
  floor: StyleFloor;
  dials: StyleDials;
  team_prose: string;
  human_prose: string;
  /** 8 hex chars of sha256 over the other four fields — the seat attests this (ADR 417 shape). */
  epoch: string;
}

/** The epoch of a resolved style: stable while nothing in it changes, different when anything does. */
export function styleEpoch(parts: Omit<ResolvedStyle, 'epoch'>): string {
  const canonical = JSON.stringify([
    parts.floor.assess_before_agreeing,
    parts.floor.disagree_once_then_commit,
    parts.floor.concession_names_check,
    parts.floor.human_critique_weighed_as_peer,
    parts.dials.pushback,
    parts.dials.bluntness,
    parts.dials.length,
    parts.dials.format,
    parts.team_prose,
    parts.human_prose,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

/**
 * Resolve how seats talk to one human (spec §4.1): the floor from policy — prefs cannot touch it —
 * each dial from prefs, else the team default; team prose then human prose. With no prefs this is
 * the team's own style, which is what `@team` and the record get.
 */
export function resolveStyle(policy: StylePolicy, prefs?: StylePrefs): ResolvedStyle {
  const parts = {
    floor: policy.floor,
    dials: {
      pushback: prefs?.pushback ?? policy.defaults.pushback,
      bluntness: prefs?.bluntness ?? policy.defaults.bluntness,
      length: prefs?.length ?? policy.defaults.length,
      format: prefs?.format ?? policy.defaults.format,
    },
    team_prose: policy.prose,
    human_prose: prefs?.prose ?? '',
  };
  return { ...parts, epoch: styleEpoch(parts) };
}

const PUSHBACK_WORDS: Record<StyleDials['pushback'], string> = {
  'every-time': 'pushback every time',
  'when-it-matters': 'pushback when it matters',
  'only-on-risk': 'pushback only on risk',
};

/** The four dials as one line: `pushback when it matters · plain · normal · prose`. */
export function describeDials(dials: StyleDials): string {
  return [PUSHBACK_WORDS[dials.pushback], dials.bluntness, dials.length, dials.format].join(' · ');
}

/** One phrase per floor boolean, in the order the spec lists them (§4.2). */
const FLOOR_PHRASES: ReadonlyArray<[keyof StyleFloor, string]> = [
  ['assess_before_agreeing', 'assess before you agree; no praise before a check'],
  ['disagree_once_then_commit', 'disagree once, with the reason, then follow the decision'],
  ['concession_names_check', 'a concession names what you checked'],
  ['human_critique_weighed_as_peer', "a human's critique weighs what its evidence weighs"],
];

function floorLine(floor: StyleFloor): string | null {
  const on = FLOOR_PHRASES.filter(([key]) => floor[key]).map(([, phrase]) => phrase);
  return on.length === 0 ? null : `Floor (team): ${on.join('; ')}.`;
}

export interface StyleBlockInput {
  /** `resolveStyle(policy)` with no prefs — what `@team` and the record get. */
  team: ResolvedStyle;
  /** The human steering this Workspace (presence driver, else the team's only human), resolved. */
  driver?: { name: string; style: ResolvedStyle };
  /** Why there is no driver line, when there is none (spec §4.3). Ignored when `driver` is set. */
  no_driver?: 'unbound' | 'several_humans';
}

/**
 * The style block a seat reads on `team_join` (spec §4.2): an instruction in prose, floor first, the
 * driver's dials and prose labelled as theirs, then what everyone else gets. No trailing newline.
 */
export function renderStyleBlock(input: StyleBlockInput): string {
  const { team, driver } = input;
  const epoch = driver?.style.epoch ?? team.epoch;
  const lines: string[] = [`Style (epoch ${epoch}) — how you talk here.`];
  const floor = floorLine(team.floor);
  if (floor) lines.push(floor);
  if (team.team_prose) lines.push(`The team adds: "${team.team_prose}"`);
  const teamDials = describeDials(team.dials);
  if (driver) {
    lines.push(
      `For ${driver.name} (in chat, and in any act addressed to ${driver.name}): ${describeDials(driver.style.dials)}.`,
    );
    if (driver.style.human_prose) lines.push(`${driver.name} adds: "${driver.style.human_prose}"`);
    lines.push(`Everyone else, @team and the record: team defaults (${teamDials}).`);
  } else {
    const why =
      input.no_driver === 'several_humans'
        ? 'No driver bound and this team has several humans'
        : 'No driver bound';
    lines.push(`${why} — team defaults in chat (\`musterd agent --driver <you>\` binds one).`);
    lines.push(`In chat, @team and the record: team defaults (${teamDials}).`);
  }
  return lines.join('\n');
}
