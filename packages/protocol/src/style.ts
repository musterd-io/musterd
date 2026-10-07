import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  STYLE_BLUNTNESS,
  STYLE_FLOOR_PHRASES,
  STYLE_FORMAT,
  STYLE_LENGTH,
  STYLE_PUSHBACK,
  describeDials,
  styleProseProblem,
} from './style.wire.js';

/**
 * Agent style (ADR 514; spec docs/superpowers/specs/2026-10-05-agent-style-design.md) — how a seat
 * talks to humans. Two layers: the **floor** and **team defaults** are team policy human admins own
 * (`PolicySchema.style`, sparse on write per ADR 185); a human's own **dials** and **prose**
 * (`members.style_prefs`) sit on top and can never lower the floor. Everything here is pure: the
 * daemon passes policy and prefs in, {@link resolveStyle} answers, {@link renderStyleBlock} prints
 * the block a seat reads on `team_join`.
 */

export {
  STYLE_BLUNTNESS,
  STYLE_DIAL_KEYS,
  STYLE_DIAL_VALUES,
  STYLE_FLOOR_PHRASES,
  STYLE_FORMAT,
  STYLE_LENGTH,
  STYLE_PROSE_MAX_CHARS,
  STYLE_PROSE_MAX_LINES,
  STYLE_PUSHBACK,
  describeDialChange,
  describeDials,
  styleProseLineCount,
  styleProseProblem,
  type StyleDialKey,
} from './style.wire.js';

/** The wire form of a style epoch: exactly what {@link styleEpoch} produces (ADR 514 inc 2). */
export const StyleEpochSchema = z.string().regex(/^[0-9a-f]{8}$/);

// superRefine, so the zod issue — what `parseOrBadRequest` hands the caller — carries the count.
const ProseSchema = z.string().superRefine((s, ctx) => {
  const problem = styleProseProblem(s);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
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

/**
 * What the daemon hands a seat on `occupied` and on `GET /style-block` (ADR 514 inc 3): the block
 * to read, the epoch to attest, the dials it resolved (so a later change can be named) and whose
 * dials they are. `driver` is null when the block carries only the team defaults.
 */
export const StyleEnvelopeSchema = z.object({
  block: z.string(),
  epoch: StyleEpochSchema,
  dials: StyleDialsSchema,
  driver: z.string().nullable(),
});
export type StyleEnvelope = z.infer<typeof StyleEnvelopeSchema>;

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
  /** The team defaults as resolved — what `@team` and the record get, printed in every block. */
  team_dials: StyleDials;
  team_prose: string;
  human_prose: string;
  /** 8 hex chars of sha256 over the other five fields — the seat attests this (ADR 417 shape). */
  epoch: string;
}

const dialTuple = (d: StyleDials) => [d.pushback, d.bluntness, d.length, d.format];

/** The epoch of a resolved style: stable while nothing in it changes, different when anything does.
 *  Hashes the whole block's content — the team defaults too, since the block prints them — so an
 *  admin moving a default a human has overridden still re-sends the block. Not the addressee's name:
 *  the epoch is the style, the driver line is who it is for. */
export function styleEpoch(parts: Omit<ResolvedStyle, 'epoch'>): string {
  const canonical = JSON.stringify([
    parts.floor.assess_before_agreeing,
    parts.floor.disagree_once_then_commit,
    parts.floor.concession_names_check,
    parts.floor.human_critique_weighed_as_peer,
    ...dialTuple(parts.dials),
    ...dialTuple(parts.team_dials),
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
    team_dials: policy.defaults,
    team_prose: policy.prose,
    human_prose: prefs?.prose ?? '',
  };
  return { ...parts, epoch: styleEpoch(parts) };
}

function floorLine(floor: StyleFloor): string | null {
  const on = STYLE_FLOOR_PHRASES.filter(([key]) => floor[key]).map(([, phrase]) => phrase);
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
  // Prose prints as a JSON string: one line, quotes and line breaks escaped, so a five-line prose
  // or one carrying a `"` can never shed its label and read as a floor line.
  if (team.team_prose) lines.push(`The team adds: ${JSON.stringify(team.team_prose)}`);
  const teamDials = describeDials(team.dials);
  if (driver) {
    lines.push(
      `For ${driver.name} (in chat, and in any act addressed to ${driver.name}): ${describeDials(driver.style.dials)}.`,
    );
    if (driver.style.human_prose)
      lines.push(`${driver.name} adds: ${JSON.stringify(driver.style.human_prose)}`);
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
