import { z } from 'zod';
import { POLL_ENDS, POLL_LIMITS } from './poll.wire.js';

/** Twitch polls (ADR 807): the schemas over `poll.wire.ts`'s shapes, which this re-exports. */
export * from './poll.wire.js';

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0, 'must not be blank');

const PollIdSchema = z.string().min(10).max(64);
const MemberNameSchema = z.string().min(1).max(64);
const Count = z.number().int().nonnegative();
const Options = z
  .array(text(POLL_LIMITS.optionMax))
  .min(POLL_LIMITS.minOptions)
  .max(POLL_LIMITS.maxOptions);

export const PollSpecSchema = z
  .object({
    question: text(POLL_LIMITS.questionMax),
    options: Options,
    minutes: z
      .number()
      .int()
      .min(POLL_LIMITS.minMinutes)
      .max(POLL_LIMITS.maxMinutes)
      .default(POLL_LIMITS.defaultMinutes),
  })
  .strict();

/** The only thing that crosses from chat to the team: integers and two observed booleans. Strict. */
export const PollCountsSchema = z
  .object({
    poll_id: PollIdSchema,
    counts: z.array(Count).min(POLL_LIMITS.minOptions).max(POLL_LIMITS.maxOptions),
    voters: Count,
    live: z.boolean(),
    post_failed: z.boolean(),
  })
  .strict();

export const OpenPollSchema = z
  .object({
    id: PollIdSchema,
    question: text(POLL_LIMITS.questionMax),
    options: Options,
    minutes: z.number().int().min(POLL_LIMITS.minMinutes).max(POLL_LIMITS.maxMinutes),
    opened_by: MemberNameSchema,
    opened_at: z.number().int().nonnegative(),
    closes_at: z.number().int().nonnegative(),
    counts: z.array(Count),
    voters: Count,
    post_failed: z.boolean(),
    poll_token: z.string().min(1).max(256).optional(),
  })
  .strict();

export const OpenPollReplySchema = z
  .object({ live: z.boolean(), poll: OpenPollSchema.nullable() })
  .strict();

const PollMetaBase = {
  id: PollIdSchema,
  question: text(POLL_LIMITS.questionMax),
  options: Options,
  opened_by: MemberNameSchema,
  opened_at: z.number().int().nonnegative(),
  closes_at: z.number().int().nonnegative(),
};

/** `meta.poll`: `open` on the daemon's message, `closed` on its resolve (ADR 807 §9). */
export const PollMetaSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open'), ...PollMetaBase }).strict(),
  z
    .object({
      state: z.literal('closed'),
      ...PollMetaBase,
      counts: z.array(Count),
      voters: Count,
      end: z.enum(POLL_ENDS),
      winners: z.array(z.number().int().nonnegative()).max(POLL_LIMITS.maxOptions),
      closed_at: z.number().int().nonnegative(),
    })
    .strict(),
]);
