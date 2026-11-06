import type { Envelope } from '@musterd/protocol';
import { vouchCheckCode } from '@musterd/protocol/approval-contracts';
import { describe, expect, it } from 'vitest';
import type { DeviceKey } from './passkeyEnroll';
import { pendingVouches, replacedPasskeys, VOUCH_TTL_MS, vouchGate, vouchRefusal } from './vouch';

const D = 'ab12cd34' + '0'.repeat(56);
const NOW = 1_800_000_000_000;

const env = (over: Partial<Envelope>): Envelope =>
  ({
    id: 'e1',
    v: 1,
    team: 'revive',
    from: 'ada',
    to: { kind: 'member', name: 'nick' },
    act: 'request_help',
    body: '',
    thread: null,
    meta: { vouch: { member: 'ada', enrollment_digest: D } },
    ts: NOW - 60_000,
    ...over,
  }) as Envelope;

const humans = new Set(['nick', 'ada', 'bo']);

describe('ADR 769: vouch requests waiting on an admin', () => {
  it('finds a human member asking me for themself, inside the held enrollment’s life', () => {
    expect(pendingVouches([env({})], 'nick', humans, NOW)).toEqual([
      { id: 'e1', member: 'ada', digest: D, ts: NOW - 60_000 },
    ]);
  });

  it('ignores a request for someone else, from an agent, to another admin, or malformed', () => {
    const cases = [
      env({ meta: { vouch: { member: 'bo', enrollment_digest: D } } }), // not for themself
      env({ from: 'grokbot', meta: { vouch: { member: 'grokbot', enrollment_digest: D } } }),
      env({ to: { kind: 'member', name: 'bo' } }),
      env({ to: { kind: 'team' } }),
      env({ act: 'message' }),
      env({ meta: { vouch: { member: 'ada', enrollment_digest: 'zz' } } }),
      env({ meta: { vouch: 'ada' } }),
    ];
    for (const c of cases) expect(pendingVouches([c], 'nick', humans, NOW)).toEqual([]);
  });

  it('drops an expired request, one I answered on its thread, and keeps the newest per member', () => {
    expect(pendingVouches([env({ ts: NOW - VOUCH_TTL_MS - 1 })], 'nick', humans, NOW)).toEqual([]);
    const answered = env({ id: 'r', from: 'nick', act: 'resolve', thread: 'e1', meta: null });
    expect(pendingVouches([env({}), answered], 'nick', humans, NOW)).toEqual([]);
    const newer = env({ id: 'e2', ts: NOW - 1_000 });
    expect(pendingVouches([env({}), newer], 'nick', humans, NOW).map((r) => r.id)).toEqual(['e2']);
  });
});

describe('ADR 769: the vouch card’s typed-code gate', () => {
  it('enables only on the code worked out from the digest', () => {
    expect(vouchGate('', D)).toBe('partial');
    expect(vouchGate('12345', D)).toBe('partial');
    expect(vouchGate(vouchCheckCode(D), D)).toBe('match');
    const wrong = vouchCheckCode(D) === '000000' ? '000001' : '000000';
    expect(vouchGate(wrong, D)).toBe('mismatch');
  });
});

describe('ADR 769: the passkeys a vouched key replaces', () => {
  const key = (over: Partial<DeviceKey>): DeviceKey => ({
    id: 'k',
    kind: 'passkey',
    created_at: 0,
    revoked_at: null,
    ...over,
  });
  it('splits dead-origin keys from unrecorded ones, and leaves keys that sign here alone', () => {
    const out = replacedPasskeys(
      [
        key({ id: 'away', rp_id: 'localhost', origin: 'http://localhost:4849' }),
        key({ id: 'old', rp_id: null }),
        key({ id: 'here', rp_id: 'hub.example' }),
        key({ id: 'gone', rp_id: 'localhost', revoked_at: 1 }),
        key({ id: 'phone', kind: 'phone', rp_id: null }),
      ],
      'hub.example',
    );
    expect(out.away.map((k) => k.id)).toEqual(['away']);
    expect(out.unrecorded.map((k) => k.id)).toEqual(['old']);
  });
});

describe('ADR 769: a refused vouch, in words', () => {
  it('names each refusal the daemon gives', () => {
    expect(vouchRefusal(new Error('passkey vouch refused (already_spent)'))).toMatch(/already/);
    expect(vouchRefusal(new Error('passkey vouch refused (expired)'))).toMatch(/expired/);
    expect(vouchRefusal(new Error('(countersigner_key_unusable)'))).toMatch(/works on this hub/);
  });
});
