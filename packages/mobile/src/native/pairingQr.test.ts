import { createHash } from 'node:crypto';
import { AppPairRequestSchema } from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { describe, expect, it } from 'vitest';
import {
  callbackUrl,
  daemonFingerprint,
  pairingChallenge,
  pairRequest,
  pairRoute,
  readPairingQr,
  relayOrigin,
} from './pairingQr';

const b64 = (bytes: number, fill: number) => Buffer.alloc(bytes, fill).toString('base64url');
const identity = b64(32, 1);
const receive = b64(65, 2);
const signing = b64(65, 3);
const code = 'd'.repeat(43);

function qr(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    relay: 'https://relay.example/team',
    team: 'revive',
    pairing: 'pair-1',
    code,
    expires_at: 4_102_444_800_000,
    daemon_identity_public_key: identity,
    daemon_receive_public_key: receive,
    ...over,
  };
}

describe('relayOrigin', () => {
  it('keeps an https origin and drops a path from https or wss', () => {
    expect(relayOrigin('https://relay.example')).toBe('https://relay.example');
    expect(relayOrigin('https://relay.example/team')).toBe('https://relay.example');
    expect(relayOrigin('wss://relay.example:8443/socket')).toBe('https://relay.example:8443');
  });

  it('refuses plaintext and userinfo', () => {
    expect(relayOrigin('http://relay.example')).toBeNull();
    expect(relayOrigin('ws://relay.example')).toBeNull();
    expect(relayOrigin('https://user:pw@relay.example')).toBeNull();
  });
});

describe('daemonFingerprint', () => {
  it('is the daemon page fingerprint: sha256 of the raw identity key, grouped', () => {
    const raw = Buffer.from(identity, 'base64url');
    const expected = createHash('sha256')
      .update(raw)
      .digest('hex')
      .slice(0, 16)
      .match(/.{4}/g)!
      .join(' ');
    expect(daemonFingerprint(identity)).toBe(expected);
    expect(daemonFingerprint('short')).toBeNull();
  });
});

describe('pairingChallenge', () => {
  it('is sha256 of the code, then the signing point, then the receive point', () => {
    const expected = createHash('sha256')
      .update(Buffer.from(code, 'utf8'))
      .update(Buffer.from(signing, 'base64url'))
      .update(Buffer.from(receive, 'base64url'))
      .digest('base64url');
    expect(pairingChallenge(code, signing, receive)).toBe(expected);
    expect(pairingChallenge(code, 'short', receive)).toBeNull();
  });
});

describe('readPairingQr', () => {
  const now = 1_000;

  it('parses a code and normalizes the relay', () => {
    const read = readPairingQr(JSON.stringify(qr()), now);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.scanned.relay).toBe('https://relay.example');
    expect(read.scanned.fingerprint).toBe(daemonFingerprint(identity));
    expect(read.scanned.qr.code).toBe(code);
  });

  it('refuses a bad code, an expired one, and a relay that is not https', () => {
    expect(readPairingQr('not json', now)).toEqual({ ok: false, reason: 'unreadable' });
    expect(readPairingQr(JSON.stringify(qr({ code: 'short' })), now)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(readPairingQr(JSON.stringify(qr({ expires_at: now })), now)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(readPairingQr(JSON.stringify(qr({ relay: 'http://relay.example' })), now)).toEqual({
      ok: false,
      reason: 'relay',
    });
  });
});

describe('pairRequest', () => {
  const scanned = readPairingQr(JSON.stringify(qr()), 1);
  if (!scanned.ok) throw new Error('fixture');
  const { qr: parsed } = scanned.scanned;

  it('seals under the pairing route and includes a usable push token', () => {
    expect(pairRoute(parsed)).toEqual({
      team: 'revive',
      binding: 'pairing',
      ref: 'pair-1',
      expires_at: parsed.expires_at,
    });
    expect(canonicalJson(pairRoute(parsed))).toBe(
      `{"binding":"pairing","expires_at":${parsed.expires_at},"ref":"pair-1","team":"revive"}`,
    );
    const token = 'ab'.repeat(32);
    const request = pairRequest({
      qr: parsed,
      signing,
      receive,
      keyId: b64(32, 5),
      attestation: 'attest',
      push: { token, environment: 'production' },
    });
    expect(AppPairRequestSchema.parse(request)).toMatchObject({
      v: 1,
      code,
      push_token: token,
      push_environment: 'production',
    });
    expect(request).not.toHaveProperty('device_name');
  });

  it('normalizes the standard Base64 key id Apple returns to base64url', () => {
    const appleKeyId = 'AcP/pnpoNVPIJYZOvmIvWzDvmxkFoQCE4Uu7Nk6WiAA=';
    const request = pairRequest({
      qr: parsed,
      signing,
      receive,
      keyId: appleKeyId,
      attestation: 'attest',
    });
    expect(request?.attest_key_id).toBe(Buffer.from(appleKeyId, 'base64').toString('base64url'));
    expect(AppPairRequestSchema.parse(request).attest_key_id).toHaveLength(43);
  });

  it('omits a push token that is not hex, and still builds the request', () => {
    const request = pairRequest({
      qr: parsed,
      signing,
      receive,
      keyId: b64(32, 5),
      attestation: 'attest',
      push: { token: 'nope', environment: 'production' },
    });
    expect(request).not.toHaveProperty('push_token');
    expect(request?.code).toBe(code);
  });

  it('builds the callback on the normalized origin', () => {
    expect(callbackUrl('https://relay.example', 'revive')).toBe(
      'https://relay.example/app/revive/callback',
    );
    expect(callbackUrl('https://relay.example/team', 'revive')).toBeNull();
    expect(callbackUrl('https://relay.example', 'a/b')).toBeNull();
  });
});
