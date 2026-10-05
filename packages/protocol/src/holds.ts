import { z } from 'zod';

/**
 * Holds (ADR 516, SPEC A.15): a time-bounded Team rule only a human admin sets or lifts. The one
 * authoritative place a Team says "this is paused" — Members read it, they do not restate it. The
 * pre-demo freeze of 2026-09-28 travelled seat to seat as prose and lost its end, its author and its
 * scope on the way; a hold carries all three and ends on its own.
 */

/** The longest hold: a demo slot plus margin, never a week-long typo (the autorefresh hold's cap). */
export const HOLD_MAX_MS = 12 * 3600_000;

/**
 * A closed set. `autorefresh_paused` and `merges_paused` are enforced (the autorefresh tick, the
 * PreToolUse gate); `notice` never is, and every renderer labels it so. An unknown effect is never
 * treated as enforced — a new one needs an ADR.
 */
export const HoldEffectSchema = z.enum(['autorefresh_paused', 'merges_paused', 'notice']);
export type HoldEffect = z.infer<typeof HoldEffectSchema>;

export const HoldSchema = z.object({
  id: z.string().min(1),
  effect: HoldEffectSchema,
  /** Why — for `notice`, the whole message. */
  reason: z.string().min(1).max(280),
  /** The human Member who set it. */
  created_by: z.string().min(1),
  created_at: z.number().int(),
  expires_at: z.number().int(),
  lifted_at: z.number().int().nullable(),
  lifted_by: z.string().nullable(),
});
export type Hold = z.infer<typeof HoldSchema>;

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
export const HoldListSchema = z.object({ holds: z.array(HoldSchema) });
export type HoldList = z.infer<typeof HoldListSchema>;

/** The joiner→hub forward of a set or a lift. The hub re-authorizes `actor` against its own roster. */
export const SyncHoldRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), actor: z.string().min(1), hold: SetHoldBodySchema }),
  z.object({ op: z.literal('lift'), actor: z.string().min(1), id: z.string().min(1) }),
]);
export type SyncHoldRequest = z.infer<typeof SyncHoldRequestSchema>;

/** Active = not lifted and not yet expired, against the reader's clock. Derived, never stored. */
export function isHoldActive(hold: Hold, nowMs: number): boolean {
  return hold.lifted_at === null && nowMs < hold.expires_at;
}

/** Is any active hold carrying `effect`? */
export function activeHoldFor(holds: Hold[], effect: HoldEffect, nowMs: number): Hold | null {
  return holds.find((h) => h.effect === effect && isHoldActive(h, nowMs)) ?? null;
}

/** Whether a renderer must say the effect is not enforced. */
export function isHoldEnforced(effect: HoldEffect): boolean {
  return effect !== 'notice';
}

const EFFECT_LABEL: Record<HoldEffect, string> = {
  autorefresh_paused: 'autorefresh paused',
  merges_paused: 'merges paused',
  notice: 'notice — not enforced',
};

/** `merges paused by nick until 15:30 (42m left): demo 14:00` — one line every surface shares. */
export function describeHoldLine(hold: Hold, nowMs: number): string {
  return `${EFFECT_LABEL[hold.effect]} by ${hold.created_by} until ${clockOf(hold.expires_at)} (${leftOf(hold.expires_at, nowMs)} left): ${hold.reason}`;
}

/** The refusal sentence for an enforced effect (refusal code `held`). */
export function holdRefusal(hold: Hold): string {
  return `held by ${hold.created_by} until ${clockOf(hold.expires_at)}: ${hold.reason}`;
}

function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function leftOf(until: number, nowMs: number): string {
  const left = Math.max(0, Math.ceil((until - nowMs) / 60_000));
  const h = Math.floor(left / 60);
  const m = left % 60;
  return h > 0 ? `${h}h${m > 0 ? `${m}m` : ''}` : `${m}m`;
}
