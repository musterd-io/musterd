import { describe, expect, it } from 'vitest';
import {
  ApprovalDescriptorSchema,
  HIGH_AUTHORITY_ACTS,
  canonicalJson,
  descriptorSigningBytes,
  isHighAuthorityAct,
  payloadDigest,
  type ApprovalDescriptor,
} from './authority.js';

describe('HIGH_AUTHORITY_ACTS (ADR 662 decision 4)', () => {
  it('pins the closed list exactly', () => {
    expect([...HIGH_AUTHORITY_ACTS]).toEqual([
      'human_accept',
      'set_authorized_by',
      'admin.team_policy',
      'admin.roster',
      'admin.team_settings',
      'grant_issue',
      'credential_mint',
      'agent_create',
      'device_key_admin',
    ]);
  });

  it('recognizes only listed acts', () => {
    expect(isHighAuthorityAct('human_accept')).toBe(true);
    expect(isHighAuthorityAct('lane.claim')).toBe(false);
    expect(isHighAuthorityAct(undefined)).toBe(false);
  });
});

describe('canonical payload digest', () => {
  it('is key-order independent and value sensitive', () => {
    expect(payloadDigest({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      payloadDigest({ a: { c: 'x', d: [1, 2] }, b: 1 }),
    );
    expect(payloadDigest({ a: 1 })).not.toBe(payloadDigest({ a: 2 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('approval descriptor', () => {
  const descriptor: ApprovalDescriptor = {
    v: 1,
    actor: 'nick',
    act: 'human_accept',
    target: '01LANE',
    payload_digest: payloadDigest({ state: 'done' }),
    audience: 'revive',
    expiry: 1_900_000_000_000,
    nonce: 'nonce-at-least-16-chars',
  };

  it('parses a well-formed descriptor and rejects an unlisted act', () => {
    expect(ApprovalDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(() => ApprovalDescriptorSchema.parse({ ...descriptor, act: 'lane.claim' })).toThrow();
  });

  it('signing bytes commit to every field', () => {
    const bytes = descriptorSigningBytes(descriptor);
    expect(bytes).toContain('musterd-approval/v1');
    for (const changed of [
      { ...descriptor, actor: 'mallory' },
      { ...descriptor, target: '01OTHER' },
      { ...descriptor, expiry: descriptor.expiry + 1 },
      { ...descriptor, nonce: 'a-different-nonce-16' },
    ]) {
      expect(descriptorSigningBytes(changed)).not.toBe(bytes);
    }
  });
});
