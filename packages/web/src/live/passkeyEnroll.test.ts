import { describe, expect, it } from 'vitest';

import { enrollRefusal, excludeCredentialsFrom } from './passkeyEnroll.js';

// Lane 01M6Q3ZJJB: a registration names the credentials this member already holds, so the
// authenticator refuses to replace the passkey this device has instead of silently doing so.
describe('excludeCredentialsFrom', () => {
  it('names every active passkey with a known credential id, and nothing else', () => {
    expect(
      excludeCredentialsFrom([
        { kind: 'passkey', revoked_at: null, credential_id: 'c-live' },
        { kind: 'passkey', revoked_at: 1, credential_id: 'c-revoked' },
        { kind: 'passkey', revoked_at: null, credential_id: null },
        { kind: 'phone', revoked_at: null, credential_id: null },
      ]),
    ).toEqual(['c-live']);
  });

  it('is empty against a daemon that does not send credential ids yet', () => {
    expect(excludeCredentialsFrom([{ kind: 'passkey', revoked_at: null }])).toEqual([]);
  });
});

describe('enrollRefusal', () => {
  it('passes the already-holds-a-passkey sentence through unchanged', () => {
    const e = new Error('this device already holds a passkey for you — use that one; nothing was enrolled');
    expect(enrollRefusal(e)).toBe(e.message);
  });
});
