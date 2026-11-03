import { z } from 'zod';

/** ADR 792: why a shift stopped. */
export const SHIFT_STOP_REASONS = ['hours_end', 'budget', 'no_work', 'stopped'] as const;
export type ShiftStopReason = (typeof SHIFT_STOP_REASONS)[number];

/**
 * ADR 792: a seat's shift today, as every surface reads it (`/live`, `musterd status`,
 * `team_status`). `ending`: stopped, while the wake already running finishes. `until` is the end
 * of today's working hours for a shift started inside them, else null (a Start outside hours runs
 * until the budget or the work runs out). `budget_left_usd` never goes below 0.
 */
export const ShiftStateSchema = z.object({
  state: z.enum(['on', 'off', 'ending']),
  since: z.number().int(),
  until: z.number().int().nullable(),
  budget_left_usd: z.number().nonnegative(),
  stop_reason: z.enum(SHIFT_STOP_REASONS).nullable(),
});
export type ShiftState = z.infer<typeof ShiftStateSchema>;
