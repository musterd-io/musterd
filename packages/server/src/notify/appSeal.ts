import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
  type webcrypto,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { canonicalJson } from '@musterd/protocol';
import { MusterdError } from '../errors.js';

/**
 * The app channel's seal (ADR 676 §2–3). Every delivery to the phone is signed with the daemon's
 * Ed25519 identity key and then sealed with HPKE (RFC 9180, base mode, DHKEM(P-256), HKDF-SHA256,
 * AES-128-GCM) to the phone's receive key; every answer comes back sealed to the daemon's receive
 * key. The relay sees only the route: team, binding, ref, expiry. The route is the HPKE AAD and is
 * inside the signature, so a relay that moves a ciphertext to another route breaks the open, and
 * one that re-seals a payload to the phone cannot sign it.
 *
 * Both daemon keys live in one file beside the effective config, chmod 600, never logged
 * (hard rule 5). Public keys travel as raw bytes, base64url: 32 bytes for Ed25519, the 65-byte
 * uncompressed point for P-256.
 */

/** What the relay is allowed to see, and what binds a sealed body to its place. */
export interface SealRoute {
  team: string;
  binding: string;
  /** The ask id for a delivery, the pairing id while pairing. */
  ref: string;
  expires_at: number;
}

/** A sealed body on the wire: the HPKE encapsulated key and the ciphertext, both base64url. */
export interface SealedBody {
  v: 1;
  enc: string;
  ct: string;
}

/** Which way a sealed body travels. It is the HPKE `info`, so a body sealed for one cannot open as the other. */
export type SealPurpose = 'deliver' | 'answer' | 'pair' | 'question_key';

export interface AppChannelKeys {
  identityPrivate: KeyObject;
  /** Ed25519 public key, raw 32 bytes, base64url — what the phone pins at pairing. */
  identityPublic: string;
  receivePrivate: webcrypto.CryptoKey;
  /** P-256 public key, uncompressed point, base64url — what the phone seals answers to. */
  receivePublic: string;
}

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

const SIGN_DOMAIN = 'musterd-app/v1 signed';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function info(purpose: SealPurpose): Uint8Array {
  return new TextEncoder().encode(`musterd-app/v1 ${purpose}`);
}

function routeBytes(route: SealRoute): Uint8Array {
  return new TextEncoder().encode(canonicalJson(route));
}

function signingBytes(route: SealRoute, payload: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(`${SIGN_DOMAIN}\n${canonicalJson(route)}\n`, 'utf8'),
    Buffer.from(payload),
  ]);
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    'base64url',
  );
}

function unb64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** An Ed25519 public key from its raw 32 bytes (base64url). */
export function ed25519PublicKey(raw: string): KeyObject {
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== 32) throw new MusterdError('bad_request', 'Ed25519 key is not 32 bytes');
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
    format: 'der',
    type: 'spki',
  });
}

/** A P-256 receive key from its raw uncompressed point (base64url), for sealing to it. */
export async function p256ReceiveKey(raw: string): Promise<webcrypto.CryptoKey> {
  const bytes = unb64(raw);
  if (bytes.length !== 65 || bytes[0] !== 0x04)
    throw new MusterdError('bad_request', 'P-256 key is not an uncompressed point');
  return suite.kem.deserializePublicKey(bytes);
}

// ── the keys outside the database ──

interface KeyFile {
  v: 1;
  /** Ed25519 private key, PKCS#8 DER, base64url. */
  identity: string;
  /** P-256 private scalar, 32 bytes, base64url. */
  receive: string;
  /** Its public point, uncompressed, base64url. */
  receive_pub: string;
}

let keysOverride: AppChannelKeys | null = null;
let keysCache: { path: string; keys: AppChannelKeys } | null = null;

/** Tests inject keys so an in-memory store never touches the home directory; `null` clears. */
export function __setAppChannelKeysForTest(keys: AppChannelKeys | null): void {
  keysOverride = keys;
  keysCache = null;
}

/** `app-channel.key` lives beside the effective config (`MUSTERD_CONFIG`, else `~/.musterd/config.json`). */
export function appChannelKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  const cfg = env['MUSTERD_CONFIG'] ?? join(homedir(), '.musterd', 'config.json');
  return join(dirname(cfg), 'app-channel.key');
}

async function keysFromFile(file: KeyFile): Promise<AppChannelKeys> {
  const identityPrivate = createPrivateKey({
    key: Buffer.from(file.identity, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  if (identityPrivate.asymmetricKeyType !== 'ed25519')
    throw new MusterdError('server_error', 'app-channel.key identity is not an Ed25519 key');
  const receivePrivate = await suite.kem.deserializePrivateKey(unb64(file.receive));
  await p256ReceiveKey(file.receive_pub);
  const spki = createPublicKey(identityPrivate).export({ format: 'der', type: 'spki' });
  return {
    identityPrivate,
    identityPublic: b64(spki.subarray(ED25519_SPKI_PREFIX.length)),
    receivePrivate,
    receivePublic: file.receive_pub,
  };
}

/** Fresh daemon keys, not written anywhere. */
export async function generateAppChannelKeys(): Promise<AppChannelKeys> {
  return keysFromFile(await freshKeyFile());
}

async function freshKeyFile(): Promise<KeyFile> {
  const { privateKey } = generateKeyPairSync('ed25519');
  const receive = await suite.kem.generateKeyPair();
  return {
    v: 1,
    identity: b64(privateKey.export({ format: 'der', type: 'pkcs8' })),
    receive: b64(await suite.kem.serializePrivateKey(receive.privateKey)),
    receive_pub: b64(await suite.kem.serializePublicKey(receive.publicKey)),
  };
}

/** Load (or on first use, generate at 0600) the daemon's app-channel keys. */
export async function loadAppChannelKeys(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppChannelKeys> {
  if (keysOverride) return keysOverride;
  const path = appChannelKeyPath(env);
  if (keysCache && keysCache.path === path) return keysCache.keys;
  let file: KeyFile;
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
    } catch {
      throw new MusterdError('server_error', `app-channel.key at ${path} is not readable JSON`);
    }
    if (
      file.v !== 1 ||
      typeof file.identity !== 'string' ||
      typeof file.receive !== 'string' ||
      typeof file.receive_pub !== 'string'
    )
      throw new MusterdError('server_error', `app-channel.key at ${path} has an unknown shape`);
  } else {
    file = await freshKeyFile();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(file) + '\n', { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  const keys = await keysFromFile(file);
  keysCache = { path, keys };
  return keys;
}

// ── seal and open ──

/**
 * Sign `payload` with the daemon identity key over the route, then seal the signed bytes to the
 * phone's receive key with the route as AAD.
 */
export async function sealToPhone(input: {
  keys: AppChannelKeys;
  phoneReceivePublic: string;
  route: SealRoute;
  payload: Uint8Array;
  purpose?: Extract<SealPurpose, 'deliver'>;
}): Promise<SealedBody> {
  const sig = cryptoSign(
    null,
    signingBytes(input.route, input.payload),
    input.keys.identityPrivate,
  );
  const inner = new TextEncoder().encode(JSON.stringify({ p: b64(input.payload), s: b64(sig) }));
  const sealed = await suite.seal(
    {
      recipientPublicKey: await p256ReceiveKey(input.phoneReceivePublic),
      info: info(input.purpose ?? 'deliver'),
    },
    inner,
    routeBytes(input.route),
  );
  return { v: 1, enc: b64(sealed.enc), ct: b64(sealed.ct) };
}

/**
 * Open a body the phone sealed to the daemon (an answer, or the pairing request). Throws
 * `forbidden` on any failure — a wrong route, a wrong purpose, a tampered byte — without saying
 * which. The phone's own signature inside is the caller's to check.
 */
export async function openFromPhone(input: {
  keys: AppChannelKeys;
  route: SealRoute;
  sealed: SealedBody;
  purpose: Exclude<SealPurpose, 'deliver'>;
}): Promise<Uint8Array> {
  if (input.sealed.v !== 1) throw new MusterdError('forbidden', 'sealed body could not be opened');
  try {
    const pt = await suite.open(
      {
        recipientKey: input.keys.receivePrivate,
        enc: unb64(input.sealed.enc),
        info: info(input.purpose),
      },
      unb64(input.sealed.ct),
      routeBytes(input.route),
    );
    return new Uint8Array(pt);
  } catch {
    throw new MusterdError('forbidden', 'sealed body could not be opened');
  }
}

/**
 * What the phone does on receipt, in TypeScript: open with its receive key, then check the
 * daemon's signature against the identity key it pinned. The app implements the same steps in
 * Swift; this copy is what the falsifier suite and the relay's tests run against.
 */
export async function openAsPhone(input: {
  phoneReceivePrivate: webcrypto.CryptoKey;
  pinnedIdentityPublic: string;
  route: SealRoute;
  sealed: SealedBody;
}): Promise<Uint8Array> {
  const fail = (): never => {
    throw new MusterdError('forbidden', 'an ask could not be verified');
  };
  if (input.sealed.v !== 1) fail();
  let inner: { p?: unknown; s?: unknown };
  try {
    const pt = await suite.open(
      {
        recipientKey: input.phoneReceivePrivate,
        enc: unb64(input.sealed.enc),
        info: info('deliver'),
      },
      unb64(input.sealed.ct),
      routeBytes(input.route),
    );
    inner = JSON.parse(new TextDecoder().decode(pt)) as { p?: unknown; s?: unknown };
  } catch {
    return fail();
  }
  if (typeof inner.p !== 'string' || typeof inner.s !== 'string') return fail();
  const payload = unb64(inner.p);
  const ok = cryptoVerify(
    null,
    signingBytes(input.route, payload),
    ed25519PublicKey(input.pinnedIdentityPublic),
    Buffer.from(inner.s, 'base64url'),
  );
  if (!ok) fail();
  return payload;
}

/** The phone side of sealing, for tests and the falsifier suite: seal to the daemon's receive key. */
export async function sealToDaemon(input: {
  daemonReceivePublic: string;
  route: SealRoute;
  payload: Uint8Array;
  purpose: Exclude<SealPurpose, 'deliver'>;
}): Promise<SealedBody> {
  const sealed = await suite.seal(
    {
      recipientPublicKey: await p256ReceiveKey(input.daemonReceivePublic),
      info: info(input.purpose),
    },
    input.payload,
    routeBytes(input.route),
  );
  return { v: 1, enc: b64(sealed.enc), ct: b64(sealed.ct) };
}

/** A fresh P-256 receive key pair as the phone would hold it (tests; the app uses its own). */
export async function generatePhoneReceiveKey(): Promise<{
  privateKey: webcrypto.CryptoKey;
  publicRaw: string;
}> {
  const kp = await suite.kem.generateKeyPair();
  return {
    privateKey: kp.privateKey,
    publicRaw: b64(await suite.kem.serializePublicKey(kp.publicKey)),
  };
}
