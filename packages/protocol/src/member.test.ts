import { describe, expect, it } from 'vitest';
import { MemberSchema, MemberSummarySchema, PresenceSchema, ResidenceSchema } from './member.js';

const base = {
  id: '01M',
  team: 'revive',
  name: 'miley',
  kind: 'agent',
  created_at: 1,
};

describe('Member.hue (ADR 374)', () => {
  it('carries an integer hue on the wheel, and the summary inherits it', () => {
    expect(MemberSchema.parse({ ...base, hue: 212 }).hue).toBe(212);
    expect(MemberSummarySchema.parse({ ...base, hue: 0, presence: 'offline' }).hue).toBe(0);
  });

  it('is nullish for back-compat — an older daemon omits it, a file without one projects null', () => {
    expect(MemberSchema.parse(base).hue).toBeUndefined();
    expect(MemberSchema.parse({ ...base, hue: null }).hue).toBeNull();
  });

  it('refuses a hue off the wheel', () => {
    expect(() => MemberSchema.parse({ ...base, hue: 360 })).toThrow();
    expect(() => MemberSchema.parse({ ...base, hue: -1 })).toThrow();
    expect(() => MemberSchema.parse({ ...base, hue: 1.5 })).toThrow();
  });
});

describe('Member.account_id (ADR 698)', () => {
  it('carries the console account binding, nullish for back-compat', () => {
    expect(MemberSchema.parse({ ...base, account_id: 'acct_1' }).account_id).toBe('acct_1');
    expect(MemberSchema.parse(base).account_id).toBeUndefined();
    expect(MemberSchema.parse({ ...base, account_id: null }).account_id).toBeNull();
    expect(() => MemberSchema.parse({ ...base, account_id: '' })).toThrow();
  });
});

describe('Presence.guidance_epoch (ADR 417)', () => {
  const base = { id: 'p1', surface: 'claude-code', status: 'online', last_seen_at: 1 };

  it('carries the epoch the occupancy attested', () => {
    expect(PresenceSchema.parse({ ...base, guidance_epoch: 24 }).guidance_epoch).toBe(24);
  });

  it('is nullish — an unstamped workspace is unknown, and unknown is not epoch 0', () => {
    expect(PresenceSchema.parse({ ...base, guidance_epoch: null }).guidance_epoch).toBeNull();
    expect(PresenceSchema.parse(base).guidance_epoch).toBeUndefined();
  });

  it('rejects a malformed stamp version', () => {
    expect(PresenceSchema.safeParse({ ...base, guidance_epoch: -1 }).success).toBe(false);
    expect(PresenceSchema.safeParse({ ...base, guidance_epoch: 1.5 }).success).toBe(false);
  });
});

describe('MemberSummary.residence (ADR 503 Decision 5)', () => {
  const summary = { ...base, presence: 'offline' };
  const residence = {
    node: '01M3ZEHWQD9PXPKEYMHGKK2YTM',
    node_label: 'macbook-air-2.lan',
    kind: 'node',
  };

  it('round-trips a node residence and a cloud one', () => {
    expect(MemberSummarySchema.parse({ ...summary, residence }).residence).toEqual(residence);
    const cloud = { ...residence, kind: 'cloud' };
    expect(ResidenceSchema.parse(JSON.parse(JSON.stringify(cloud)))).toEqual(cloud);
  });

  it('is nullish — null is "enrolled, no node bound"; absent is an older daemon', () => {
    expect(MemberSummarySchema.parse({ ...summary, residence: null }).residence).toBeNull();
    expect(MemberSummarySchema.parse(summary).residence).toBeUndefined();
  });

  it('refuses an unknown kind and an empty node id', () => {
    expect(ResidenceSchema.safeParse({ ...residence, kind: 'laptop' }).success).toBe(false);
    expect(ResidenceSchema.safeParse({ ...residence, node: '' }).success).toBe(false);
  });
});
