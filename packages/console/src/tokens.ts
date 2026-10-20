import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  type JsonWebKey,
} from 'node:crypto';

/**
 * Console tokens (spec §4.3, ADR 685). ES256 compact JWS, 60 seconds, one audience, one `jti`.
 * The signature is ieee-p1363, which is what the team server checks. Cloud KMS returns DER;
 * `derToP1363` is the conversion. No JOSE library (hard rule 6).
 */

export const TOKEN_LIFETIME_S = 60;

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

/** Something that can sign a JWT input and publish the matching public key. */
export interface TokenSigner {
  publicJwk(): Promise<PublicJwk>;
  /** Sign `header.payload` and return the raw ieee-p1363 signature. */
  sign(input: Uint8Array): Promise<Uint8Array>;
}

/** An audience a team server pinned. Opaque, bounded, no whitespace or controls. */
export function audienceOk(aud: string): boolean {
  if (aud.length < 1 || aud.length > 200) return false;
  if (/\s/.test(aud)) return false;
  return ![...aud].some((c) => c.charCodeAt(0) < 0x20);
}

const DER_ERROR = 'ECDSA signature is not a P-256 DER encoding';

function readLen(buf: Buffer, at: number): { len: number; next: number } {
  const b = buf[at];
  if (b === undefined) throw new Error(DER_ERROR);
  if (b < 0x80) return { len: b, next: at + 1 };
  if (b === 0x81) {
    const n = buf[at + 1];
    if (n === undefined || n < 0x80) throw new Error(DER_ERROR);
    return { len: n, next: at + 2 };
  }
  throw new Error(DER_ERROR);
}

/**
 * DER ECDSA (SEQUENCE of two INTEGERs) to raw r||s, each left-padded to 32 bytes.
 * One leading 0x00 on an INTEGER is the sign byte and is stripped.
 */
export function derToP1363(der: Uint8Array): Buffer {
  const buf = Buffer.from(der);
  if (buf.length < 8 || buf[0] !== 0x30) throw new Error(DER_ERROR);
  const seq = readLen(buf, 1);
  if (seq.next + seq.len !== buf.length) throw new Error(DER_ERROR);
  let i = seq.next;
  const parts: Buffer[] = [];
  for (let n = 0; n < 2; n++) {
    if (buf[i++] !== 0x02) throw new Error(DER_ERROR);
    const len = readLen(buf, i);
    i = len.next;
    if (len.len < 1 || i + len.len > buf.length) throw new Error(DER_ERROR);
    let int = buf.subarray(i, i + len.len);
    i += len.len;
    if (int.length > 0 && int[0] === 0x00) int = int.subarray(1);
    if (int.length > 32) throw new Error(DER_ERROR);
    parts.push(Buffer.concat([Buffer.alloc(32 - int.length), int]));
  }
  if (i !== buf.length) throw new Error(DER_ERROR);
  return Buffer.concat(parts);
}

/** `kid` is the first 16 characters of the base64url SHA-256 of the SPKI PEM. Not the key version. */
export function kidForPem(pem: string): string {
  return createHash('sha256').update(pem).digest('base64url').slice(0, 16);
}

/** The public JWK the console publishes. EC P-256 only. */
export function publicJwkFromPem(pem: string): PublicJwk {
  let jwk: JsonWebKey;
  try {
    jwk = createPublicKey(pem).export({ format: 'jwk' });
  } catch {
    throw new Error('signing key is not EC P-256');
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y)
    throw new Error('signing key is not EC P-256');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x,
    y: jwk.y,
    kid: kidForPem(pem),
    alg: 'ES256',
    use: 'sig',
  };
}

/** A process-local P-256 signer. Tests and the in-process console. Not a production fallback. */
export function localSigner(): TokenSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const jwk = publicJwkFromPem(pem);
  return {
    publicJwk: async () => jwk,
    sign: async (input) =>
      cryptoSign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  };
}

export interface TokenClaims {
  iss: string;
  sub: string;
  aud: string;
  nowS: number;
}

const b64url = (s: string) => Buffer.from(s).toString('base64url');

/**
 * One compact JWS. `jti` is returned beside the token so the audit row can name it without
 * parsing the token back. `nowS` is the caller's clock, in seconds.
 */
export async function signConsoleToken(
  signer: TokenSigner,
  c: TokenClaims,
): Promise<{ token: string; jti: string }> {
  if (!audienceOk(c.aud)) throw new Error('bad audience');
  const pub = await signer.publicJwk();
  const jti = randomUUID();
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: pub.kid }));
  const payload = b64url(
    JSON.stringify({
      iss: c.iss,
      sub: c.sub,
      aud: c.aud,
      jti,
      iat: c.nowS,
      exp: c.nowS + TOKEN_LIFETIME_S,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const sig = await signer.sign(Buffer.from(signingInput));
  return { token: `${signingInput}.${Buffer.from(sig).toString('base64url')}`, jti };
}
