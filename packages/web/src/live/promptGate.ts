/**
 * The composer's gates (lanes 01M4H4ARQC, 01M4H7MNN4), on their own so the route's EAGER graph carries
 * only these two small checks — everything the composer sends (`promptAct.ts`) rides its lazy chunk.
 */

/** `?promptbar=1` / `?promptbar` or `#promptbar` — the first of the bar's three gates. */
export function promptBarFlag(search: string, hash: string): boolean {
  if (hash === '#promptbar') return true;
  const v = new URLSearchParams(search).get('promptbar');
  return v !== null && v !== '0' && v !== 'false';
}

/**
 * All three gates (lane 01M4H4ARQC): the flag, a signed-in member (never the read-only observer,
 * ADR 063), and an admin. Any one missing and the route mounts nothing.
 */
export function promptBarVisible(g: { flag: boolean; signedIn: boolean; admin: boolean }): boolean {
  return g.flag && g.signedIn && g.admin;
}
