import { createHash, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APPLE_APP_ATTEST_ROOT_PEM,
  appPairingChallenge,
  verifyAppAttestation,
} from './appAttest.js';
import { fakeAppAttest } from './appAttest.testkit.js';

const NOW = 1_800_000_000_000;
const APP_ID = 'ABCDE12345.io.musterd.app';
const challenge = createHash('sha256').update('pairing').digest();

function verify(over: Parameters<typeof fakeAppAttest>[0] extends infer O ? Partial<O> : never) {
  const f = fakeAppAttest({ appId: APP_ID, clientDataHash: challenge, now: NOW, ...over });
  return {
    f,
    result: verifyAppAttestation({
      attestation: f.attestation,
      clientDataHash: challenge,
      keyId: f.keyId,
      appId: APP_ID,
      now: NOW,
      roots: [f.root],
    }),
  };
}

describe('App Attest verification (ADR 676 §5)', () => {
  it('pins the Apple App Attestation Root CA by fingerprint', () => {
    const root = new X509Certificate(APPLE_APP_ATTEST_ROOT_PEM);
    expect(root.fingerprint256).toBe(
      '1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32',
    );
    expect(root.subject).toContain('Apple App Attestation Root CA');
  });

  it('accepts a well-formed attestation and names its environment', () => {
    const { f, result } = verify({});
    expect(result).toEqual({
      ok: true,
      environment: 'production',
      keyId: f.keyId.toString('base64url'),
    });
    expect(verify({ aaguid: Buffer.from('appattestdevelop') }).result).toMatchObject({
      ok: true,
      environment: 'development',
    });
  });

  it('a chain that does not reach the trusted root is refused', () => {
    expect(verify({ foreignRoot: true }).result).toEqual({ ok: false, reason: 'chain_invalid' });
    // Our own fake chain against Apple's real root (the production default).
    const f = fakeAppAttest({ appId: APP_ID, clientDataHash: challenge, now: NOW });
    expect(
      verifyAppAttestation({
        attestation: f.attestation,
        clientDataHash: challenge,
        keyId: f.keyId,
        appId: APP_ID,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'chain_invalid' });
  });

  it('an attestation minted for another challenge is refused', () => {
    const f = fakeAppAttest({ appId: APP_ID, clientDataHash: challenge, now: NOW });
    const other = createHash('sha256').update('another pairing').digest();
    expect(
      verifyAppAttestation({
        attestation: f.attestation,
        clientDataHash: other,
        keyId: f.keyId,
        appId: APP_ID,
        now: NOW,
        roots: [f.root],
      }),
    ).toEqual({ ok: false, reason: 'nonce_mismatch' });
    expect(verify({ wrongNonce: true }).result).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it('another app, a used key, a foreign AAGUID, a swapped key id and a wrong format are refused', () => {
    const f = fakeAppAttest({
      appId: 'ZZZZZ99999.com.other.app',
      clientDataHash: challenge,
      now: NOW,
    });
    expect(
      verifyAppAttestation({
        attestation: f.attestation,
        clientDataHash: challenge,
        keyId: f.keyId,
        appId: APP_ID,
        now: NOW,
        roots: [f.root],
      }),
    ).toEqual({ ok: false, reason: 'app_id_mismatch' });
    expect(verify({ counter: 1 }).result).toEqual({ ok: false, reason: 'counter_nonzero' });
    expect(verify({ aaguid: Buffer.alloc(16) }).result).toEqual({
      ok: false,
      reason: 'aaguid_invalid',
    });
    expect(verify({ wrongCredentialId: true }).result).toEqual({
      ok: false,
      reason: 'key_id_mismatch',
    });
    expect(verify({ fmt: 'packed' }).result).toEqual({ ok: false, reason: 'wrong_format' });
    const g = fakeAppAttest({ appId: APP_ID, clientDataHash: challenge, now: NOW });
    expect(
      verifyAppAttestation({
        attestation: g.attestation,
        clientDataHash: challenge,
        keyId: Buffer.alloc(32, 7),
        appId: APP_ID,
        now: NOW,
        roots: [g.root],
      }),
    ).toEqual({ ok: false, reason: 'key_id_mismatch' });
  });

  it('an expired chain and garbage bytes are refused', () => {
    const f = fakeAppAttest({ appId: APP_ID, clientDataHash: challenge, now: NOW });
    expect(
      verifyAppAttestation({
        attestation: f.attestation,
        clientDataHash: challenge,
        keyId: f.keyId,
        appId: APP_ID,
        now: NOW + 3 * 86_400_000,
        roots: [f.root],
      }),
    ).toEqual({ ok: false, reason: 'chain_invalid' });
    expect(
      verifyAppAttestation({
        attestation: Buffer.from('not cbor at all'),
        clientDataHash: challenge,
        keyId: f.keyId,
        appId: APP_ID,
      }),
    ).toMatchObject({ ok: false });
  });

  it('the pairing challenge binds the code and both phone keys', () => {
    const a = appPairingChallenge('code', Buffer.alloc(65, 1), Buffer.alloc(65, 2));
    expect(a).toHaveLength(32);
    expect(a.equals(appPairingChallenge('code', Buffer.alloc(65, 1), Buffer.alloc(65, 3)))).toBe(
      false,
    );
    expect(a.equals(appPairingChallenge('cod3', Buffer.alloc(65, 1), Buffer.alloc(65, 2)))).toBe(
      false,
    );
  });
});
