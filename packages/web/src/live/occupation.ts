/**
 * The roles a nameplate shows (lane 01M5FY2XFX). A stream viewer asked "can you show their occupations"
 * (2026-10-20), and the plate answers with the seat's roles by their real names: the role library's
 * own ids, as the roster holds them (ADR 227). nick, 2026-10-21: no viewer-facing translation. A word
 * map (lane 01M5FXZF49) was tried first and dropped, because a second vocabulary for the same fact
 * drifts, and a role whose name reads badly on a plate gets renamed in the roster instead.
 *
 * The face shows the first; the expanded /live plate lists them all. `roles` is every role the seat
 * holds; where it is absent or empty (a fixture, an older daemon) the single display `role` is read.
 */
export function seatRoles(
  roles: readonly string[] | null | undefined,
  role: string | null | undefined,
): string[] {
  const held = roles?.length ? roles : [role ?? ''];
  return [...new Set(held.map((r) => r.trim()).filter((r) => r.length > 0))];
}

/** The roles a human's plate never folds away, in the order they outrank each other. */
export const GOVERNANCE_ROLES = ['founder', 'admin'] as const;

/**
 * The one role the plate's face wears. A human who holds `founder` or `admin` wears that, founder
 * first when both (nick, 2026-10-28: "if a human has both founder and admin, just show the founder");
 * everyone else wears their first role. The expanded plate still lists them all.
 */
export function plateRole(held: readonly string[], kind: 'human' | 'agent' | string): string | null {
  if (kind === 'human') {
    for (const g of GOVERNANCE_ROLES) if (held.includes(g)) return g;
  }
  return held[0] ?? null;
}

/** Whether `job` is a role the plate keeps showing when it folds (idle or away). */
export function isGovernanceRole(job: string | null, kind: string): boolean {
  return kind === 'human' && job !== null && (GOVERNANCE_ROLES as readonly string[]).includes(job);
}
