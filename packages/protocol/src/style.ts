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
