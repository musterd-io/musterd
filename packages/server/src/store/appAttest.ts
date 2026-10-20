import { createHash, X509Certificate } from 'node:crypto';
import { decodeCbor } from './webauthn.js';

/**
 * App Attest verification for pairing the musterd app (ADR 676 §5), with no new dependency: the
 * CBOR decoder is the one WebAuthn already uses, and the one certificate extension App Attest adds
 * is read with a small DER walker below. Apple's steps, in order
 * (developer.apple.com, "Validating apps that connect to your server"):
 *
 *   1. the `x5c` chain verifies to Apple's App Attestation Root CA, valid now;
 *   2. nonce = sha256(authData ‖ clientDataHash) equals the leaf's 1.2.840.113635.100.8.2 value;
 *   3. sha256 of the leaf's public key (uncompressed point) is the key id;
 *   4. authData's RP id hash is sha256 of the app id (`<team id>.<bundle id>`);
 *   5. the sign counter is 0;
 *   6. the AAGUID is `appattest` + seven zero bytes (production) or `appattestdevelop`;
 *   7. the credential id is the key id.
 *
 * The receipt is not checked: it feeds Apple's fraud-metric service, which pairing does not use.
 * `clientDataHash` is the pairing challenge, sha256(code ‖ phone signing key ‖ phone receive key),
 * so an attestation minted for one pairing or one pair of keys verifies for no other.
 */

/** Apple App Attestation Root CA, from apple.com/certificateauthority; sha256 fingerprint pinned in the test. */
export const APPLE_APP_ATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

const NONCE_OID = Buffer.from('2a864886f763640802', 'hex'); // 1.2.840.113635.100.8.2
const AAGUID_PRODUCTION = Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]);
const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop');

export type AppAttestRefusal =
  | 'malformed'
  | 'wrong_format'
  | 'chain_invalid'
  | 'nonce_mismatch'
  | 'key_id_mismatch'
  | 'app_id_mismatch'
  | 'counter_nonzero'
  | 'aaguid_invalid';

export type AppAttestResult =
  | { ok: true; environment: 'production' | 'development'; keyId: string }
  | { ok: false; reason: AppAttestRefusal };

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** The pairing challenge the app passes to `attestKey` as its clientDataHash (ADR 676 §5). */
export function appPairingChallenge(
  code: string,
  signingPublicRaw: Uint8Array,
  receivePublicRaw: Uint8Array,
): Buffer {
  return sha256(Buffer.from(code, 'utf8'), signingPublicRaw, receivePublicRaw);
}

// ── a DER walker: just enough to find one extension ──

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

function readTlv(buf: Uint8Array, pos: number): Tlv {
  const tag = buf[pos];
  let lenByte = buf[pos + 1];
  if (tag === undefined || lenByte === undefined) throw new Error('der: truncated');
  let p = pos + 2;
  let len = lenByte;
  if (lenByte & 0x80) {
    const n = lenByte & 0x7f;
    if (n === 0 || n > 4) throw new Error('der: unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) {
      lenByte = buf[p++];
      if (lenByte === undefined) throw new Error('der: truncated');
      len = len * 256 + lenByte;
    }
  }
  if (p + len > buf.length) throw new Error('der: truncated');
  return { tag, start: p, end: p + len };
}

function children(buf: Uint8Array, tlv: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = tlv.start; p < tlv.end; ) {
    const c = readTlv(buf, p);
    out.push(c);
    p = c.end;
  }
  return out;
}

/** The App Attest nonce from a leaf certificate's DER, or null when the extension is absent. */
export function attestNonceFromCert(der: Uint8Array): Buffer | null {
  const cert = readTlv(der, 0);
  const tbs = children(der, cert)[0];
  if (!tbs) return null;
  const extsWrapper = children(der, tbs).find((c) => c.tag === 0xa3);
  if (!extsWrapper) return null;
  const exts = children(der, extsWrapper)[0];
  if (!exts) return null;
  for (const ext of children(der, exts)) {
    const parts = children(der, ext);
    const oid = parts[0];
    if (!oid || oid.tag !== 0x06) continue;
    if (!Buffer.from(der.subarray(oid.start, oid.end)).equals(NONCE_OID)) continue;
    const value = parts[parts.length - 1];
    if (!value || value.tag !== 0x04) return null;
    // extnValue: SEQUENCE { [1] EXPLICIT OCTET STRING nonce }
    const seq = readTlv(der, value.start);
    const tagged = children(der, seq).find((c) => c.tag === 0xa1);
    if (!tagged) return null;
    const octets = readTlv(der, tagged.start);
    if (octets.tag !== 0x04) return null;
    return Buffer.from(der.subarray(octets.start, octets.end));
  }
  return null;
}

function uncompressedPoint(cert: X509Certificate): Buffer | null {
  const jwk = cert.publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return null;
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

function validAt(cert: X509Certificate, now: number): boolean {
  return Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);
}

/**
 * Verify one App Attest attestation object. `roots` exists for tests, which build their own
 * chain; production always passes Apple's root (the default) and nothing reads it from config.
 */
export function verifyAppAttestation(input: {
  attestation: Uint8Array;
  clientDataHash: Uint8Array;
  keyId: Uint8Array;
  appId: string;
  now?: number;
  roots?: X509Certificate[];
}): AppAttestResult {
  const now = input.now ?? Date.now();
  const roots = input.roots ?? [new X509Certificate(APPLE_APP_ATTEST_ROOT_PEM)];
  let fmt: unknown;
  let x5c: unknown;
  let authData: unknown;
  try {
    const top = decodeCbor(input.attestation).value;
    if (!(top instanceof Map)) return { ok: false, reason: 'malformed' };
    fmt = top.get('fmt');
    const stmt = top.get('attStmt');
    authData = top.get('authData');
    x5c = stmt instanceof Map ? stmt.get('x5c') : undefined;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (fmt !== 'apple-appattest') return { ok: false, reason: 'wrong_format' };
  if (!Array.isArray(x5c) || x5c.length < 2 || !(authData instanceof Uint8Array))
    return { ok: false, reason: 'malformed' };
  const [leafDer, intermediateDer] = x5c;
  if (!(leafDer instanceof Uint8Array) || !(intermediateDer instanceof Uint8Array))
    return { ok: false, reason: 'malformed' };

  // 1. The chain.
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  try {
    leaf = new X509Certificate(leafDer);
    intermediate = new X509Certificate(intermediateDer);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const root = roots.find(
    (r) => intermediate.checkIssued(r) && intermediate.verify(r.publicKey) && validAt(r, now),
  );
  if (
    !root ||
    !intermediate.ca ||
    !validAt(intermediate, now) ||
    !leaf.checkIssued(intermediate) ||
    !leaf.verify(intermediate.publicKey) ||
    !validAt(leaf, now)
  )
    return { ok: false, reason: 'chain_invalid' };

  // 2. The nonce.
  let certNonce: Buffer | null;
  try {
    certNonce = attestNonceFromCert(leafDer);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!certNonce || !certNonce.equals(sha256(authData, input.clientDataHash)))
    return { ok: false, reason: 'nonce_mismatch' };

  // 3. The key id.
  const point = uncompressedPoint(leaf);
  const keyId = Buffer.from(input.keyId);
  if (!point || !sha256(point).equals(keyId)) return { ok: false, reason: 'key_id_mismatch' };

  // 4–7. The authenticator data: rpIdHash(32) flags(1) counter(4) aaguid(16) credIdLen(2) credId.
  if (authData.length < 55) return { ok: false, reason: 'malformed' };
  const ad = Buffer.from(authData);
  if (!ad.subarray(0, 32).equals(sha256(Buffer.from(input.appId, 'utf8'))))
    return { ok: false, reason: 'app_id_mismatch' };
  if (ad.readUInt32BE(33) !== 0) return { ok: false, reason: 'counter_nonzero' };
  const aaguid = ad.subarray(37, 53);
  const environment = aaguid.equals(AAGUID_PRODUCTION)
    ? 'production'
    : aaguid.equals(AAGUID_DEVELOPMENT)
      ? 'development'
      : null;
  if (!environment) return { ok: false, reason: 'aaguid_invalid' };
  const credLen = ad.readUInt16BE(53);
  if (ad.length < 55 + credLen) return { ok: false, reason: 'malformed' };
  if (!ad.subarray(55, 55 + credLen).equals(keyId)) return { ok: false, reason: 'key_id_mismatch' };

  return { ok: true, environment, keyId: keyId.toString('base64url') };
}
