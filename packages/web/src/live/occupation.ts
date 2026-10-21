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
