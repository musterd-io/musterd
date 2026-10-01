import { z } from 'zod';

/**
 * The huddle trace (ADR 493): one huddle as a single timeline — the open and the steers, each seat's
 * wake, its structural tool steps and hook outcomes, its turn in the room, and the close. Served by
 * `GET /teams/:slug/huddles/:id/trace`; `musterd huddle show <id> --trace` and `/live` render it as
 * given and derive no join of their own.
 *
 * Structure only: a tool event names the tool, its outcome and its duration, and the schema has no
 * field that could carry content or `detail` (ADR 493 §4, the ADR 445 seat-timeline limit). zod's
 * default `object` strips unknown keys, so a writer that tried would lose the field at parse.
 */

/** ADR 493 §5: an answer past this many events is cut and says so (`truncated`). */
export const HUDDLE_TRACE_MAX_EVENTS = 2_000;

/** ADR 493 §2: an open huddle's window stops this long after its open. */
export const HUDDLE_TRACE_MAX_WINDOW_MS = 2 * 60 * 60 * 1000;

export const HUDDLE_TRACE_EVENT_KINDS = ['act', 'wake', 'tool', 'hook', 'session'] as const;
export const HuddleTraceEventKindSchema = z.enum(HUDDLE_TRACE_EVENT_KINDS);

/** How a seat came to be in the room. */
export const HUDDLE_TRACE_SUMMONS = ['opener', 'named', 'steered', 'joined'] as const;

export const HuddleTraceWakeSchema = z.object({
  lease_id: z.string(),
  leased_at: z.number().int().min(0),
  spawned_at: z.number().int().min(0).nullable(),
  /** fresh or resumed, as the woken session attested; null until it does. */
  session: z.enum(['fresh', 'resumed']).nullable(),
  /** The furthest the wake got: leased, then woke, failed or deferred. */
  outcome: z.enum(['leased', 'woke', 'failed', 'deferred']),
  duration_ms: z.number().min(0).nullable(),
  cost_usd: z.number().min(0).nullable(),
});
export type HuddleTraceWake = z.infer<typeof HuddleTraceWakeSchema>;

export const HuddleTraceSeatSchema = z.object({
  seat: z.string(),
  harness: z.string().nullable(),
  summoned: z.enum(HUDDLE_TRACE_SUMMONS),
  summoned_at: z.number().int().min(0),
  /** The act that summoned the seat (the open, or its steer); null for a seat that joined. */
  summoned_by: z.string().nullable(),
  wake: HuddleTraceWakeSchema.nullable(),
  first_turn_at: z.number().int().min(0).nullable(),
  /** The act id of that first turn, so a surface can attach the seat's steps to its turn line. */
  first_turn_act_id: z.string().nullable(),
  time_to_turn_ms: z.number().int().min(0).nullable(),
});
export type HuddleTraceSeat = z.infer<typeof HuddleTraceSeatSchema>;

/** A stable word for each wake or session step, so every surface says it the same way (ADR 493). */
export const HUDDLE_TRACE_PHASES = [
  'leased',
  'captured',
  'woke',
  'failed',
  'deferred',
  'settled',
  'started',
  'prompted',
  'stopped',
  'ended',
] as const;

export const HuddleTraceEventSchema = z.object({
  ts: z.number().int().min(0),
  seat: z.string(),
  kind: HuddleTraceEventKindSchema,
  label: z.string(),
  /** Set on `wake` and `session` events: the step, in {@link HUDDLE_TRACE_PHASES}. */
  phase: z.enum(HUDDLE_TRACE_PHASES).optional(),
  act_id: z.string().optional(),
  tool_name: z.string().optional(),
  outcome: z.string().optional(),
  duration_ms: z.number().min(0).optional(),
});
export type HuddleTraceEvent = z.infer<typeof HuddleTraceEventSchema>;

export const HuddleTraceSchema = z.object({
  huddle: z.object({
    id: z.string(),
    topic: z.string(),
    anchor: z.string(),
    opener: z.string(),
    opened_at: z.number().int().min(0),
    body: z.string(),
    closed: z
      .object({ at: z.number().int().min(0), by: z.string(), anchor_ref: z.string().nullable() })
      .nullable(),
  }),
  seats: z.array(HuddleTraceSeatSchema),
  events: z.array(HuddleTraceEventSchema).max(HUDDLE_TRACE_MAX_EVENTS),
  truncated: z.boolean(),
});
export type HuddleTrace = z.infer<typeof HuddleTraceSchema>;
