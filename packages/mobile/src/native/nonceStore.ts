/**
 * The seen-nonce store's decision, with no keychain of its own (ADR 676 decision 8).
 *
 * The notification extension keeps the records in one keychain item and calls the same rules
 * the Swift copy in `SeenNonce.swift` does — this file is the spec those rules are tested
 * against. A delivery is shown once: `fresh` inserts it, `replay` means it is already there,
 * `expired` means its own expiry has passed and it is not inserted. Records whose expiry has
 * passed are pruned on every call, so the item does not grow for ever.
 *
 * Expired does not insert, and a replay is not written again. The caller consumes only after
 * the seal and the signature have verified, and never for a delivery it is about to show as
 * unverified — an attacker must not be able to burn a nonce they could not open.
 */

export interface NonceRecord {
  /** The ask's nonce, or the route ref for a held or paired delivery (those carry no nonce). */
  key: string;
  /** Unix milliseconds. A record with `expiresAt <= now` is already dead. */
  expiresAt: number;
}

export type NonceVerdict = 'fresh' | 'replay' | 'expired';

export function consumeNonce(
  records: readonly NonceRecord[],
  key: string,
  expiresAt: number,
  now: number,
): { records: NonceRecord[]; verdict: NonceVerdict } {
  const live = records.filter((record) => record.expiresAt > now);
  if (expiresAt <= now) return { records: live, verdict: 'expired' };
  if (live.some((record) => record.key === key)) return { records: live, verdict: 'replay' };
  return { records: [...live, { key, expiresAt }], verdict: 'fresh' };
}
