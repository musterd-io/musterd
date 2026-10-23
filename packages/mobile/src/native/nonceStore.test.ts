import { describe, expect, it } from 'vitest';
import { consumeNonce, type NonceRecord } from './nonceStore';

describe('consumeNonce', () => {
  const now = 1_000;

  it('inserts a fresh key and prunes records that have already expired', () => {
    const prior: NonceRecord[] = [
      { key: 'dead', expiresAt: now },
      { key: 'live', expiresAt: now + 1 },
    ];
    const result = consumeNonce(prior, 'nonce-1', now + 5, now);
    expect(result.verdict).toBe('fresh');
    expect(result.records).toEqual([
      { key: 'live', expiresAt: now + 1 },
      { key: 'nonce-1', expiresAt: now + 5 },
    ]);
  });

  it('does not insert an expired delivery', () => {
    const result = consumeNonce([], 'nonce-1', now, now);
    expect(result).toEqual({ records: [], verdict: 'expired' });
  });

  it('does not write a replay again', () => {
    const prior = [{ key: 'nonce-1', expiresAt: now + 5 }];
    const result = consumeNonce(prior, 'nonce-1', now + 9, now);
    expect(result).toEqual({ records: prior, verdict: 'replay' });
  });
});
