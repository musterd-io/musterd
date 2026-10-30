import { z } from 'zod';
import { PR_EVENT_STATES, QUICK_ACTIONS } from './quickAction.wire.js';

/** The zod face of quick actions and PR events (ADR 779); the vocabulary and the line are `quickAction.wire.js`. */
export * from './quickAction.wire.js';

export const QuickActionSchema = z.enum(QUICK_ACTIONS);

export const PrEventSchema = z
  .object({
    lane: z.string().min(1),
    pr: z.number().int().positive(),
    state: z.enum(PR_EVENT_STATES),
    checks_url: z.string().url().optional(),
  })
  .strict();
