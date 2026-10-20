import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';

/**
 * A fake App Attest for tests: a self-signed root, an intermediate and a leaf built by hand in
 * DER, and an attestation object in CBOR, shaped exactly as Apple's. Production never imports
 * this; `verifyAppAttestation` only trusts it when a test passes its root explicitly.
 */

// ── DER ──

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const oid = (hex: string): Buffer => tlv(0x06, Buffer.from(hex, 'hex'));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const int = (n: number): Buffer => tlv(0x02, Buffer.from([n]));
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utcTime = (ms: number): Buffer => {
  const d = new Date(ms).toISOString(); // 2026-10-20T03:00:00.000Z
  const s = `${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
};

const ECDSA_SHA256 = seq(oid('2a8648ce3d040302'));
const CN = '550403';
const name = (cn: string): Buffer => seq(set(seq(oid(CN), utf8(cn))));

export const NONCE_OID_HEX = '2a864886f763640802';

function cert(opts: {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signer: KeyObject;
  serial: number;
  notBefore: number;
  notAfter: number;
  ca?: boolean;
  nonce?: Buffer;
}): Buffer {
  const exts: Buffer[] = [];
  if (opts.ca) exts.push(seq(oid('551d13'), bool(true), octets(seq(bool(true)))));
  if (opts.nonce) exts.push(seq(oid(NONCE_OID_HEX), octets(seq(tlv(0xa1, octets(opts.nonce))))));
  const tbs = seq(
    tlv(0xa0, int(2)),
    int(opts.serial),
    ECDSA_SHA256,
    name(opts.issuer),
    seq(utcTime(opts.notBefore), utcTime(opts.notAfter)),
    name(opts.subject),
    opts.publicKey.export({ format: 'der', type: 'spki' }),
    ...(exts.length ? [tlv(0xa3, seq(...exts))] : []),
  );
  const sig = cryptoSign('sha256', tbs, opts.signer);
  return seq(tbs, ECDSA_SHA256, bits(sig));
}

// ── CBOR (encode only what an attestation object holds) ──

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
type Cbor = string | Buffer | Cbor[] | Map<string, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([cborHead(3, b.length), b]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([cborHead(4, v.length), ...v.map(cbor)]);
  const parts: Buffer[] = [cborHead(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export interface FakeAppAttest {
  root: X509Certificate;
  attestation: Buffer;
  keyId: Buffer;
}

/** Build an attestation as a real device would, with knobs to break each check. */
export function fakeAppAttest(opts: {
  appId: string;
  clientDataHash: Buffer;
  now: number;
  aaguid?: Buffer;
  counter?: number;
  /** Corrupt the leaf's nonce. */
  wrongNonce?: boolean;
  /** Put a different credential id in authData than the attested key's hash. */
  wrongCredentialId?: boolean;
  /** Sign the intermediate with a key that is not the root's. */
  foreignRoot?: boolean;
  fmt?: string;
}): FakeAppAttest {
  const ec = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rootKeys = ec();
  const interKeys = ec();
  const leafKeys = ec();
  const day = 86_400_000;
  const rootDer = cert({
    subject: 'Fake App Attestation Root CA',
    issuer: 'Fake App Attestation Root CA',
    publicKey: rootKeys.publicKey,
    signer: rootKeys.privateKey,
    serial: 1,
    notBefore: opts.now - 365 * day,
    notAfter: opts.now + 365 * day,
    ca: true,
  });
  const interDer = cert({
    subject: 'Fake App Attestation CA 1',
    issuer: 'Fake App Attestation Root CA',
    publicKey: interKeys.publicKey,
    signer: opts.foreignRoot ? ec().privateKey : rootKeys.privateKey,
    serial: 2,
    notBefore: opts.now - 30 * day,
    notAfter: opts.now + 30 * day,
    ca: true,
  });
  const jwk = leafKeys.publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  const keyId = sha256(point);
  const credId = opts.wrongCredentialId ? sha256(keyId) : keyId;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(opts.counter ?? 0);
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(credId.length);
  const authData = Buffer.concat([
    sha256(Buffer.from(opts.appId, 'utf8')),
    Buffer.from([0x40]),
    counter,
    opts.aaguid ?? Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]),
    credLen,
    credId,
  ]);
  const nonce = sha256(authData, opts.clientDataHash);
  const leafDer = cert({
    subject: keyId.toString('hex'),
    issuer: 'Fake App Attestation CA 1',
    publicKey: leafKeys.publicKey,
    signer: interKeys.privateKey,
    serial: 3,
    notBefore: opts.now - day,
    notAfter: opts.now + day,
    nonce: opts.wrongNonce ? sha256(nonce) : nonce,
  });
  const attestation = cbor(
    new Map<string, Cbor>([
      ['fmt', opts.fmt ?? 'apple-appattest'],
      [
        'attStmt',
        new Map<string, Cbor>([
          ['x5c', [leafDer, interDer]],
          ['receipt', Buffer.from('receipt')],
        ]),
      ],
      ['authData', authData],
    ]),
  );
  return { root: new X509Certificate(rootDer), attestation, keyId };
}
