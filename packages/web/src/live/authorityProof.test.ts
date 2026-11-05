import { describe, expect, it } from 'vitest';

import { passkeysToOffer } from './authorityProof.js';

// ADR 808 inc B, lane 01M6Q1QMTF: a revoke descriptor is never offered to the key it names while
// another stands — the daemon refuses a key's approval of its own revocation as
// `descriptor_mismatch`, and a browser offered every passkey picked exactly that one.
describe('passkeysToOffer', () => {
  const a = { key_id: 'k-a', credential_id: 'c-a' };
  const b = { key_id: 'k-b', credential_id: 'c-b' };

  it('offers every passkey when nothing is excluded (enroll)', () => {
    expect(passkeysToOffer([a, b])).toEqual([a, b]);
  });

  it('leaves the key under revocation out when another stands', () => {
    expect(passkeysToOffer([a, b], 'k-b')).toEqual([a]);
  });

  it('offers the last key alone so it may revoke itself', () => {
    expect(passkeysToOffer([b], 'k-b')).toEqual([b]);
  });

  it('offers nothing when there is nothing', () => {
    expect(passkeysToOffer([], 'k-b')).toEqual([]);
  });
});
