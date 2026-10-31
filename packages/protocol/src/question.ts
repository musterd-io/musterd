import { z } from 'zod';
import {
  ANSWER_CHANNELS,
  ANSWER_TEXT_MAX,
  QUESTION_AUDIENCES,
  QUESTION_CONSEQUENCE_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_MAX_OPTIONS,
  QUESTION_TEXT_MAX,
  QUESTION_WHY_MAX,
  type Question,
} from './question.wire.js';

/** The zod face of question asks (ADR 773); the shapes, limits and the answer line are `question.wire.js`. */
export * from './question.wire.js';

export const QuestionOptionSchema = z
  .object({
    label: z.string().min(1).max(QUESTION_LABEL_MAX),
    consequence: z.string().min(1).max(QUESTION_CONSEQUENCE_MAX).optional(),
  })
  .strict();

export const QuestionSchema = z
  .object({
    text: z.string().min(1).max(QUESTION_TEXT_MAX),
    why: z.string().min(1).max(QUESTION_WHY_MAX).optional(),
    options: z.array(QuestionOptionSchema).max(QUESTION_MAX_OPTIONS).optional(),
    context: z
      .object({
        lane: z.string().min(1).optional(),
        pr: z.number().int().positive().optional(),
        branch: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    blocking: z.boolean().default(false),
    audience: z.enum(QUESTION_AUDIENCES).default('addressee'),
    inferred: z.boolean().default(false),
  })
  .strict();

export const AnswerSchema = z
  .object({
    choice: z
      .number()
      .int()
      .min(0)
      .max(QUESTION_MAX_OPTIONS - 1)
      .optional(),
    text: z.string().min(1).max(ANSWER_TEXT_MAX).optional(),
  })
  .strict()
  .refine((a) => a.choice !== undefined || a.text !== undefined, {
    message: 'an answer carries choice, text, or both',
  });

export const AnswerProofSchema = z
  .object({
    channel: z.enum(ANSWER_CHANNELS),
    verified: z.boolean(),
    by: z.string().min(1),
    late: z.boolean().optional(),
  })
  .strict();

export const QuestionMeasuresSchema = z.object({
  window_days: z.number().int().positive(),
  asked: z.number().int().nonnegative(),
  answered: z.number().int().nonnegative(),
  answered_off_terminal: z.number().int().nonnegative(),
  inferred: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  undelivered: z.number().int().nonnegative(),
  unflagged_undelivered: z.number().int().nonnegative(),
  resume_p50_ms: z.number().nonnegative().nullable(),
});

/** ADR 779 §5: what a person stores; seat and channel names bounded, values closed. */
export const QuestionNotifyPrefsSchema = z
  .object({
    channels: z.record(z.string().min(1).max(32), z.enum(['buzz', 'quiet'])).optional(),
    seats: z.record(z.string().min(1).max(64), z.enum(['always', 'never'])).optional(),
  })
  .strict()
  .refine(
    (p) => Object.keys(p.channels ?? {}).length <= 16 && Object.keys(p.seats ?? {}).length <= 200,
    {
      message: 'too many entries',
    },
  );

/** The question an act's meta carries, parsed with defaults — `null` when absent or malformed. */
export function questionOf(meta: Record<string, unknown> | null | undefined): Question | null {
  const parsed = QuestionSchema.safeParse(meta?.['question']);
  return parsed.success ? parsed.data : null;
}
