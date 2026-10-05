/**
 * Holds (ADR 516) without a validator — the closed effect set, the cap, and the pure reads every
 * surface shares. `holds.ts` builds the zod schemas from these; the browser (`/live`'s banner) reads
 * this module through `@musterd/protocol/wire` so a hold line costs no zod in its bundle.
 */

/** The longest hold: a demo slot plus margin, never a week-long typo (the autorefresh hold's cap). */
export const HOLD_MAX_MS = 12 * 3600_000;

/**
 * A closed set. `autorefresh_paused` and `merges_paused` are enforced (the autorefresh tick, the
 * PreToolUse gate); `notice` never is, and every renderer labels it so. An unknown effect is never
 * treated as enforced — a new one needs an ADR.
 */
export const HOLD_EFFECTS = ['autorefresh_paused', 'merges_paused', 'notice'] as const;
export type HoldEffect = (typeof HOLD_EFFECTS)[number];

/** The shape `HoldSchema` parses to — declared here so the pure reads need no zod. */
export interface Hold {
  id: string;
  effect: HoldEffect;
  /** Why — for `notice`, the whole message. */
  reason: string;
  /** The human Member who set it. */
  created_by: string;
  created_at: number;
  expires_at: number;
  lifted_at: number | null;
  lifted_by: string | null;
}

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
