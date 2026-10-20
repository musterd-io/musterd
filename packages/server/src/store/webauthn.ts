import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/**
 * The passkey half of ADR 662 decision 5, with no new dependency: just enough CBOR to read
 * a COSE public key, and the WebAuthn checks that matter — the challenge is the one the
 * server minted, the ceremony is on an origin this daemon is configured for (its own
 * origin or musterd.io — never a relay-hosted page, ADR 618 §2), and the signature covers
 * authenticatorData ‖ sha256(clientDataJSON). Supports EdDSA (-8) and ES256 (-7).
 * Attestation is 'none'-grade: registration proves possession of the credential and binds
 * its public key; no attestation statement is verified (no authenticator allowlist exists).
 */

type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | Map<number | string, CborValue>;

/** Decode one CBOR item; returns the value and the offset just past it. Throws on truncation. */
export function decodeCbor(buf: Uint8Array, offset = 0): { value: CborValue; next: number } {
  const head = buf[offset];
  if (head === undefined) throw new Error('cbor: truncated');
  const major = head >> 5;
  const info = head & 0x1f;
  let pos = offset + 1;
  const readLen = (): number => {
    if (info < 24) return info;
    if (info === 24) return buf[pos++]!;
    if (info === 25) {
      const v = (buf[pos]! << 8) | buf[pos + 1]!;
      pos += 2;
      return v;
    }
    if (info === 26) {
      const v = buf[pos]! * 2 ** 24 + (buf[pos + 1]! << 16) + (buf[pos + 2]! << 8) + buf[pos + 3]!;
      pos += 4;
      return v;
    }
    throw new Error('cbor: unsupported length');
  };
  switch (major) {
    case 0:
      return { value: readLen(), next: pos };
    case 1:
      return { value: -1 - readLen(), next: pos };
    case 2: {
      const len = readLen();
      const out = buf.slice(pos, pos + len);
      if (out.length !== len) throw new Error('cbor: truncated bytes');
      return { value: out, next: pos + len };
    }
    case 3: {
      const len = readLen();
      const out = new TextDecoder().decode(buf.slice(pos, pos + len));
      return { value: out, next: pos + len };
    }
    case 4: {
      const len = readLen();
      const arr: CborValue[] = [];
      for (let i = 0; i < len; i++) {
        const item = decodeCbor(buf, pos);
        arr.push(item.value);
        pos = item.next;
      }
      return { value: arr, next: pos };
    }
    case 5: {
      const len = readLen();
      const map = new Map<number | string, CborValue>();
      for (let i = 0; i < len; i++) {
        const k = decodeCbor(buf, pos);
        const v = decodeCbor(buf, k.next);
        if (typeof k.value !== 'number' && typeof k.value !== 'string') {
          throw new Error('cbor: unsupported map key');
        }
        map.set(k.value, v.value);
        pos = v.next;
      }
      return { value: map, next: pos };
    }
    case 7: {
      if (info === 20) return { value: false, next: pos };
      if (info === 21) return { value: true, next: pos };
      if (info === 22) return { value: null, next: pos };
      throw new Error('cbor: unsupported simple value');
    }
    default:
      throw new Error('cbor: unsupported major type');
  }
}

/** A COSE public key (EdDSA or ES256) as a Node key object, and its SPKI base64url form. */
export function cosePublicKey(cose: Map<number | string, CborValue>): {
  key: KeyObject;
  spki: string;
} {
  const alg = cose.get(3);
  const x = cose.get(-2);
  if (!(x instanceof Uint8Array)) throw new Error('webauthn: COSE key missing x coordinate');
  let key: KeyObject;
  if (alg === -8) {
    key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(x).toString('base64url') },
      format: 'jwk',
    });
  } else if (alg === -7) {
    const y = cose.get(-3);
    if (!(y instanceof Uint8Array)) throw new Error('webauthn: COSE key missing y coordinate');
    key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: Buffer.from(x).toString('base64url'),
        y: Buffer.from(y).toString('base64url'),
      },
      format: 'jwk',
    });
  } else {
    throw new Error(`webauthn: unsupported COSE alg ${String(alg)}`);
  }
  return { key, spki: key.export({ format: 'der', type: 'spki' }).toString('base64url') };
}

export interface ParsedAuthData {
  rpIdHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  hasAttestedCredential: boolean;
  credentialId?: Uint8Array;
  publicKeySpki?: string;
  publicKey?: KeyObject;
}

export function parseAuthData(authData: Uint8Array): ParsedAuthData {
  if (authData.length < 37) throw new Error('webauthn: authenticator data too short');
  const flags = authData[32]!;
  const parsed: ParsedAuthData = {
    rpIdHash: authData.slice(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    hasAttestedCredential: (flags & 0x40) !== 0,
  };
  if (parsed.hasAttestedCredential) {
    const credIdLen = (authData[53]! << 8) | authData[54]!;
    const credIdStart = 55;
    parsed.credentialId = authData.slice(credIdStart, credIdStart + credIdLen);
    const coseStart = credIdStart + credIdLen;
    const cose = decodeCbor(authData, coseStart);
    if (!(cose.value instanceof Map)) throw new Error('webauthn: COSE key is not a map');
    const { key, spki } = cosePublicKey(cose.value);
    parsed.publicKey = key;
    parsed.publicKeySpki = spki;
  }
  return parsed;
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

function parseClientData(json: string): ClientData {
  const parsed = JSON.parse(json) as ClientData;
  if (typeof parsed.type !== 'string' || typeof parsed.challenge !== 'string') {
    throw new Error('webauthn: malformed client data');
  }
  return parsed;
}

function checkRpAndChallenge(
  authData: Uint8Array,
  clientDataJson: string,
  expectedType: string,
  expectedChallenge: string,
  expectedOrigins?: readonly string[],
): { auth: ParsedAuthData; clientData: ClientData } {
  const clientData = parseClientData(clientDataJson);
  if (clientData.type !== expectedType) throw new Error('webauthn: wrong ceremony type');
  if (clientData.challenge !== expectedChallenge) throw new Error('webauthn: challenge mismatch');
  // ADR 662 dec. 5 / ADR 618 §2: the ceremony must be on an origin the daemon is
  // configured for (its own origin, or musterd.io) — an origin the caller merely
  // claims, e.g. a relay-hosted page, never verifies, however consistent it looks.
  // No configured list fails closed: a call site that forgets the list refuses
  // every ceremony rather than skipping the check (HA3 re-review).
  if (!expectedOrigins || expectedOrigins.length === 0) {
    throw new Error('webauthn: no configured origin for this daemon');
  }
  if (!expectedOrigins.includes(clientData.origin)) {
    throw new Error('webauthn: origin not configured for this daemon');
  }
  const rpId = new URL(clientData.origin).hostname;
  const rpHash = createHash('sha256').update(rpId, 'utf8').digest();
  const auth = parseAuthData(authData);
  if (!Buffer.from(auth.rpIdHash).equals(rpHash)) throw new Error('webauthn: rpId mismatch');
  if (!auth.userPresent) throw new Error('webauthn: user presence not asserted');
  return { auth, clientData };
}

/** Pull `authData` out of a registration's attestationObject (CBOR `{fmt, attStmt, authData}`). */
export function extractAuthData(attestationObject: Uint8Array): Uint8Array {
  const top = decodeCbor(attestationObject);
  if (!(top.value instanceof Map)) throw new Error('webauthn: attestation object is not a map');
  const authData = top.value.get('authData');
  if (!(authData instanceof Uint8Array)) {
    throw new Error('webauthn: attestation object carries no authData');
  }
  return authData;
}

/** Verify a registration: returns the credential id and SPKI public key to enroll. */
export function verifyRegistration(input: {
  authenticatorData: Uint8Array;
  clientDataJson: string;
  expectedChallenge: string;
  /** Enrollment (ADR 662 dec. 6): the ceremony must be user-verified, not merely present. */
  requireUserVerified?: boolean;
  /** ADR 662 dec. 5: origins this daemon accepts ceremonies from (its own, musterd.io). */
  expectedOrigins?: readonly string[] | undefined;
}): { credentialId: string; publicKeySpki: string } {
  const { auth } = checkRpAndChallenge(
    input.authenticatorData,
    input.clientDataJson,
    'webauthn.create',
    input.expectedChallenge,
    input.expectedOrigins,
  );
  if (input.requireUserVerified && !auth.userVerified) {
    throw new Error('webauthn: user verification not asserted');
  }
  if (!auth.hasAttestedCredential || !auth.credentialId || !auth.publicKeySpki) {
    throw new Error('webauthn: registration carries no attested credential');
  }
  return {
    credentialId: Buffer.from(auth.credentialId).toString('base64url'),
    publicKeySpki: auth.publicKeySpki,
  };
}

/** Verify an assertion against an enrolled credential's public key (SPKI base64url). */
export function verifyAssertion(input: {
  authenticatorData: Uint8Array;
  clientDataJson: string;
  signature: Uint8Array;
  publicKeySpki: string;
  expectedChallenge: string;
  /** ADR 662 dec. 5: origins this daemon accepts ceremonies from (its own, musterd.io). */
  expectedOrigins?: readonly string[] | undefined;
}): boolean {
  try {
    checkRpAndChallenge(
      input.authenticatorData,
      input.clientDataJson,
      'webauthn.get',
      input.expectedChallenge,
      input.expectedOrigins,
    );
    const clientHash = createHash('sha256').update(input.clientDataJson, 'utf8').digest();
    const signed = Buffer.concat([Buffer.from(input.authenticatorData), clientHash]);
    const key = createPublicKey({
      key: Buffer.from(input.publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    const type = (key.asymmetricKeyType ?? '') as string;
    if (type === 'ed25519') return cryptoVerify(null, signed, key, input.signature);
    if (type === 'ec') {
      return cryptoVerify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, input.signature);
    }
    return false;
  } catch {
    return false;
  }
}
