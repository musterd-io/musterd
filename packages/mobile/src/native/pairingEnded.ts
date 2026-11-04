/**
 * ADR 802: the daemon's word that this phone's pairing has ended. `superseded` means the daemon's
 * key changed after this phone was paired (a rotation, a hub move). `revoked` means the human
 * unpaired this phone. The relay carries it as `410 {"ended": …}` on a body fetch.
 *
 * It is not signed. The phone only shows a note that links to Pair; it forgets nothing and
 * trusts nothing new, so a forged one can do no more than ask the human to pair again (ADR 802
 * §5). A delivery that fails a check still shows only the generic text (ADR 676 decision 3).
 */
export type PairingEnded = 'superseded' | 'revoked';

/** The `ended` of a 410 body, or null for anything else. */
export function readEnded(body: unknown): PairingEnded | null {
  if (typeof body !== 'object' || body === null) return null;
  const ended = (body as Record<string, unknown>)['ended'];
  return ended === 'superseded' || ended === 'revoked' ? ended : null;
}

/** The note's words, the same on Home and Seats. */
export function endedNote(ended: PairingEnded): { title: string; body: string } {
  return ended === 'superseded'
    ? {
        title: 'Your team’s daemon changed',
        body: 'This phone was paired with its old key, so asks can’t reach it. Pair again to keep getting them.',
      }
    : {
        title: 'This phone was unpaired',
        body: 'Asks no longer reach it. Pair again to keep getting them.',
      };
}
