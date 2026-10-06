import { z } from 'zod';
import { HOLD_EFFECTS, type Hold } from './holds.wire.js';

/**
 * Holds (ADR 516, SPEC A.15): a time-bounded Team rule only a human admin sets or lifts. The one
 * authoritative place a Team says "this is paused" — Members read it, they do not restate it. The
 * pre-demo freeze of 2026-09-28 travelled seat to seat as prose and lost its end, its author and its
 * scope on the way; a hold carries all three and ends on its own.
 *
 * The zod face. The effect tuple, the cap and the pure reads live in `holds.wire.ts`, so the browser
 * can render a hold without pulling zod in.
 */
export {
  HOLD_EFFECTS,
  HOLD_MAX_MS,
  activeHoldFor,
  describeHoldLine,
  holdRefusal,
  isHoldActive,
  isHoldEnforced,
  isMergeShapedCommand,
  type Hold,
  type HoldEffect,
} from './holds.wire.js';

export const HoldEffectSchema = z.enum(HOLD_EFFECTS);

export const HoldSchema: z.ZodType<Hold> = z.object({
  id: z.string().min(1),
  effect: HoldEffectSchema,
  reason: z.string().min(1).max(280),
  created_by: z.string().min(1),
  created_at: z.number().int(),
  expires_at: z.number().int(),
  lifted_at: z.number().int().nullable(),
  lifted_by: z.string().nullable(),
});

/** `POST /teams/:slug/holds` — exactly one of `until` (epoch ms) or `for_ms`. */
export const SetHoldBodySchema = z
  .object({
    effect: HoldEffectSchema,
    reason: z.string().trim().min(1).max(280),
    until: z.number().int().positive().optional(),
    for_ms: z.number().int().positive().optional(),
  })
  .refine((b) => (b.until === undefined) !== (b.for_ms === undefined), {
    message: 'give exactly one of until or for_ms',
  });
export type SetHoldBody = z.infer<typeof SetHoldBodySchema>;

export const HoldResponseSchema = z.object({ hold: HoldSchema });
/**
 * `GET /teams/:slug/holds`. `can_set` (ADR 516 increment 4) is whether THIS reader may set or lift a
 * hold — a human admin — computed by the daemon per reader, the ADR 501 `can_halt` shape: /live
 * renders its controls from this alone, never from the viewer's role in a client. Absent on an older
 * daemon, which a client reads as `false`.
 */
export const HoldListSchema = z.object({
  holds: z.array(HoldSchema),
  can_set: z.boolean().optional(),
});
export type HoldList = z.infer<typeof HoldListSchema>;

/**
 * ADR 516 increment 3: where a hold came from when an agent proposed it. `proposal_ask` is the
 * `ask` carrying `meta.hold_proposal` that a human admin accepted; one proposal yields one hold.
 */
export const HoldProvenanceSchema = z.object({
  proposal_ask: z.string().min(1),
  proposed_by: z.string().min(1).nullable(),
});
export type HoldProvenance = z.infer<typeof HoldProvenanceSchema>;

/** The joiner→hub forward of a set or a lift. The hub re-authorizes `actor` against its own roster. */
export const SyncHoldRequestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set'),
    actor: z.string().min(1),
    hold: SetHoldBodySchema,
    /** Increment 3: the proposal ask a human accepted, and who proposed it — recorded, deduped. */
    provenance: HoldProvenanceSchema.optional(),
  }),
  z.object({ op: z.literal('lift'), actor: z.string().min(1), id: z.string().min(1) }),
]);
export type SyncHoldRequest = z.infer<typeof SyncHoldRequestSchema>;

/**
 * `POST /teams/:slug/holds/check` (ADR 516 increment 2) — the PreToolUse gate asks before a
 * merge-shaped command runs. The daemon re-tests the command itself and decides; the answer is an
 * ordinary `GateDecision` (outcome `denied_held` when an active `merges_paused` hold stops it).
 */
export const HoldCheckRequestSchema = z.object({
  tool: z.string().min(1).max(64),
  command: z.string().max(8192),
});
export type HoldCheckRequest = z.infer<typeof HoldCheckRequestSchema>;
