import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { bindingDeviceName } from '../pairingClient';
import {
  countdown,
  pairedLine,
  pairingRefusal,
  stagedToAdopt,
  qrSvg,
  recallDaemonFingerprint,
  rememberDaemonFingerprint,
} from './PairPhone';

describe('pairing a phone from /live (lane 01M64DSBQV)', () => {
  it('draws the QR as dark modules on a white field, one module per unit', async () => {
    const text = JSON.stringify({ v: 1, pairing: 'p1', code: 'c'.repeat(43) });
    const svg = await qrSvg(text);
    const n = encode(text, { ecc: 'L', border: 4 }).data.length;
    expect(svg).toContain(`viewBox="0 0 ${n} ${n}"`);
    expect(svg).toContain('fill="#fff"');
    const dark = encode(text, { ecc: 'L', border: 4 }).data.flat().filter(Boolean).length;
    expect(svg.match(/h1v1h-1z/g)).toHaveLength(dark);
  });

  it('counts down in minutes and seconds, never below zero', () => {
    expect(countdown(272_000)).toBe('4:32');
    expect(countdown(1_000)).toBe('0:01');
    expect(countdown(-5_000)).toBe('0:00');
  });

  it('names an already-paired phone by the name it paired with, and when (lane 01M64M4PY5)', () => {
    const at = new Date(2026, 9, 29, 12).getTime();
    const b = {
      id: 'b1',
      channel: 'app',
      status: 'active',
      created_at: at,
      app_keys: JSON.stringify({ device_name: 'Nick’s iPhone', push_token: 'x' }),
    };
    expect(pairedLine(b, at).device).toBe('Nick’s iPhone');
    expect(pairedLine(b, at).since).toMatch(/29/);
    expect(bindingDeviceName({ ...b, app_keys: null })).toBeNull();
    expect(bindingDeviceName({ ...b, app_keys: '{not json' })).toBeNull();
    expect(pairedLine({ ...b, app_keys: null }, at).device).toBe('your phone');
  });

  it('a refused confirm or reject says why in plain words, and ends the pairing when the server has (lane 01M6KYZ1SM)', () => {
    // nick, 2026-11-04: "Not my phone" on a pairing the server had closed showed the raw code and
    // left the panel stuck on "wants to pair" until a reload.
    const closed = pairingRefusal(new Error('pairing not_awaiting_confirmation'));
    expect(closed?.restart).toBe(true);
    expect(closed?.text).not.toContain('not_awaiting_confirmation');
    expect(closed?.text).toMatch(/Pair a phone/);
    expect(pairingRefusal(new Error('pairing expired'))?.restart).toBe(true);
    expect(pairingRefusal(new Error('pairing not_found'))?.restart).toBe(true);
    // A cancelled passkey prompt is not a server refusal: the pairing still waits.
    expect(pairingRefusal(new Error('The operation was aborted.'))).toBeNull();
  });

  it('remembers the daemon fingerprint across a reload, per team (lane 01M6KYZ1SM)', () => {
    const held = new Map<string, string>();
    const store = {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
    };
    expect(recallDaemonFingerprint('revive', store)).toBeNull();
    rememberDaemonFingerprint('revive', 'ab12 cd34', store);
    expect(recallDaemonFingerprint('revive', store)).toBe('ab12 cd34');
    expect(recallDaemonFingerprint('other', store)).toBeNull();
  });

  it('an ended pairing is never adopted again from a stale waiting list (izzo, review of #3820)', () => {
    const app = { fingerprint: 'f', environment: 'production', device_name: null, enroll_payload: { action: 'enroll' as const, public_key: 'k', kind: 'phone' as const } };
    const p1 = { id: 'p1', channel: 'app', check_code: '00', state: 'awaiting_confirmation', provider_tenant_id: null, provider_user_id: null, expires_at: 9, created_at: 1, app };
    const ended = new Set<string>();
    // The panel shows p1, the daemon refuses it (or the person rejects it): the panel ends p1.
    expect(stagedToAdopt([p1], ended)?.id).toBe('p1');
    ended.add('p1');
    // The parent's refresh is still in flight, so the waiting list still holds p1: not adopted.
    expect(stagedToAdopt([p1], ended)).toBeUndefined();
    // The refresh lands without it: still nothing.
    expect(stagedToAdopt([], ended)).toBeUndefined();
    // A new phone's request is adopted as before.
    expect(stagedToAdopt([p1, { ...p1, id: 'p2' }], ended)?.id).toBe('p2');
  });
});
