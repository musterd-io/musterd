import { z } from 'zod';
import { ALLOWANCE_KINDS, ALLOWANCE_PROVIDERS } from './allowance.wire.js';

export { ALLOWANCE_KINDS, ALLOWANCE_PROVIDERS };
export type { AllowanceKind, AllowanceProvider } from './allowance.wire.js';

/** One-way account key: 16 lowercase hex. The raw id and the token never travel. */
const accountKey = z.string().regex(/^[0-9a-f]{16}$/);

const windowBase = {
  name: z.string().min(1).max(40),
  /** Share remaining, 0 to 1. The card's bar is this, not how much was used. */
  left: z.number().finite().min(0).max(1),
  resetsAt: z.number().int().nullable(),
};

const percentWindow = z
  .object({
    ...windowBase,
    kind: z.literal('percent'),
  })
  .strict();

const amountWindow = z
  .object({
    ...windowBase,
    kind: z.literal('amount'),
    used: z.number().finite().nonnegative(),
    limit: z.number().finite().positive(),
    unit: z.string().min(1).max(24),
  })
  .strict();

/** A percent window carries no counts. An amount window carries them for the title only. */
export const AllowanceWindowSchema = z.discriminatedUnion('kind', [percentWindow, amountWindow]);
export type AllowanceWindow = z.infer<typeof AllowanceWindowSchema>;

const accountView = z
  .object({
    provider: z.enum(ALLOWANCE_PROVIDERS),
    label: z.string().min(1).max(40),
    readAt: z.number().int().positive(),
    windows: z.array(AllowanceWindowSchema).min(1).max(8),
  })
  .strict();

/**
 * What one allowance process posts after a good read (ADR 723). Strict, so a token or a raw
 * account id is a 400 rather than something we strip and forget we saw.
 */
export const AllowancePostSchema = z
  .object({
    accounts: z
      .array(
        accountView
          .extend({
            account: accountKey,
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type AllowancePost = z.infer<typeof AllowancePostSchema>;

/**
 * The roster field. No account key. Absent on the member means an older daemon, no reading, or a
 * broadcast reader — null is not used.
 */
export const AllowanceViewSchema = z
  .object({
    readAt: z.number().int().positive(),
    accounts: z.array(accountView).min(1).max(8),
  })
  .strict();
export type AllowanceView = z.infer<typeof AllowanceViewSchema>;
