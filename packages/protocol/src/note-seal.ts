import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type NoteRecipient,
  type NoteRecipients,
  parseSealedNote,
  SEALED_NOTE_HEADLINE,
  SEALED_NOTE_PREFIX,
  type SealedNote,
} from './claim-handshake.js';

/**
 * Sealing a human seat's note to that human's machines (ADR 657) — Node-only, so it sits on its own
 * subpath and never reaches a browser bundle. The scheme is `age`'s shape on Node's built-in crypto:
 * a random content key encrypts `{headline, body}` with AES-256-GCM; for each recipient machine a
 * fresh ephemeral X25519 key agrees a secret with that machine's public key, HKDF-SHA256 derives a
 * key-wrapping key from it, and AES-256-GCM wraps the content key. Opening tries every stanza.
 */

const INFO = Buffer.from('musterd note v1');
const AAD = Buffer.from('mssealed1');
/** A wrapping key is used once (fresh ephemeral per stanza), so a fixed nonce is safe for it. */
const WRAP_IV = Buffer.alloc(12);
/** The DER prefix of an X25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface NoteKey {
  /** The raw 32-byte public key, base64url — what the server stores on this machine's node. */
  public_key: string;
  private: KeyObject;
}

export interface OpenedNote {
  headline: string;
  body: string;
}

/** Where this machine's note key lives: `MUSTERD_NOTE_KEY`, else beside `MUSTERD_CONFIG`, else
 *  `~/.musterd/note-key.json`. Under vitest with neither set, a per-process temp file. */
export function noteKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['MUSTERD_NOTE_KEY'];
  if (override) return override;
  const config = env['MUSTERD_CONFIG'];
  if (config) return join(dirname(config), 'note-key.json');
  // A test that set neither gets a per-process temp key — never the operator's real one (ADR 190).
  if (env['VITEST']) return join(tmpdir(), `musterd-note-key-${process.pid}.json`);
  return join(homedir(), '.musterd', 'note-key.json');
}

function rawPublic(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' });
  return der.subarray(X25519_SPKI_PREFIX.length).toString('base64url');
}

function publicFromRaw(raw: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw, 'base64url')]),
    format: 'der',
    type: 'spki',
  });
}

/** This machine's note key, or null when it has none yet. */
export function loadNoteKey(path: string): NoteKey | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; private_key?: unknown };
  if (parsed.v !== 1 || typeof parsed.private_key !== 'string') {
    throw new Error(`${path} is not a musterd note key (ADR 657)`);
  }
  const priv = createPrivateKey({
    key: Buffer.from(parsed.private_key, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  return { public_key: rawPublic(createPublicKey(priv)), private: priv };
}

/** A fresh note key held in memory only — for tests, and for nothing that must survive the process. */
export function generateNoteKey(): NoteKey {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { public_key: rawPublic(publicKey), private: privateKey };
}

/** This machine's note key, made (mode 0600) the first time a human seat here needs one. */
export function loadOrCreateNoteKey(path: string): NoteKey {
  const existing = loadNoteKey(path);
  if (existing) return existing;
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const public_key = rawPublic(publicKey);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  writeFileSync(
    path,
    JSON.stringify({ v: 1, public_key, private_key: der.toString('base64url') }) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  chmodSync(path, 0o600);
  return { public_key, private: privateKey };
}

function wrapKey(shared: Buffer, epk: string, pk: string): Buffer {
  const salt = Buffer.concat([Buffer.from(epk, 'base64url'), Buffer.from(pk, 'base64url')]);
  return Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
}

function gcm(key: Buffer, iv: Buffer, plain: Buffer, aad?: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(aad);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function ungcm(key: Buffer, iv: Buffer, sealed: Buffer, aad?: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

function stanza(node: string, pk: string, content: Buffer): SealedNote['to'][number] {
  const eph = generateKeyPairSync('x25519');
  const epk = rawPublic(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(pk) });
  const wrap = gcm(wrapKey(shared, epk, pk), WRAP_IV, content).toString('base64url');
  return { node, pk, epk, wrap };
}

function encode(note: SealedNote): string {
  return SEALED_NOTE_PREFIX + Buffer.from(JSON.stringify(note), 'utf8').toString('base64url');
}

/** The machines a seal goes to: every trusted machine that has registered a key. */
export function keyedRecipients(
  recipients: readonly NoteRecipient[],
): { node: string; pk: string }[] {
  return recipients.flatMap((r) => (r.public_key ? [{ node: r.node_id, pk: r.public_key }] : []));
}

/** Seal `{headline, body}` to `to` (at least one machine). Returns the stored body string. */
export function sealNote(note: OpenedNote, to: readonly { node: string; pk: string }[]): string {
  if (to.length === 0) throw new Error('a sealed note needs at least one machine to open it');
  const content = randomBytes(32);
  const iv = randomBytes(12);
  const ct = gcm(content, iv, Buffer.from(JSON.stringify(note), 'utf8'), AAD);
  return encode({
    v: 1,
    to: to.map((r) => stanza(r.node, r.pk, content)),
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
  });
}

function contentKey(note: SealedNote, key: NoteKey): Buffer | null {
  for (const s of note.to) {
    if (s.pk !== key.public_key) continue;
    try {
      const shared = diffieHellman({ privateKey: key.private, publicKey: publicFromRaw(s.epk) });
      return ungcm(wrapKey(shared, s.epk, s.pk), WRAP_IV, Buffer.from(s.wrap, 'base64url'));
    } catch {
      // a stanza that does not open with this key — try the next
    }
  }
  return null;
}

/** Open a stored sealed body with this machine's key; null when this machine is not a recipient
 *  (or the body is not a sealed note, or it fails to authenticate). */
export function openNote(body: string, key: NoteKey): OpenedNote | null {
  const note = parseSealedNote(body);
  if (!note) return null;
  const content = contentKey(note, key);
  if (!content) return null;
  try {
    const plain = ungcm(
      content,
      Buffer.from(note.iv, 'base64url'),
      Buffer.from(note.ct, 'base64url'),
      AAD,
    );
    const parsed = JSON.parse(plain.toString('utf8')) as Partial<OpenedNote>;
    if (typeof parsed.headline !== 'string' || typeof parsed.body !== 'string') return null;
    return { headline: parsed.headline, body: parsed.body };
  } catch {
    return null;
  }
}

/** True when `to` names a machine (or a changed key) the sealed note does not reach yet — the
 *  newly-trusted case a machine that can open the note re-seals for. */
export function needsReseal(body: string, to: readonly { node: string; pk: string }[]): boolean {
  const note = parseSealedNote(body);
  if (!note) return true;
  const have = new Set(note.to.map((s) => `${s.node}:${s.pk}`));
  return to.some((r) => !have.has(`${r.node}:${r.pk}`));
}

// ── The seat-side flow, shared by the CLI and the MCP adapter ────────────────────────────────────

/** The plain-text caps the daemon can no longer measure once a note is sealed (ADR 093, ADR 657). */
export const PLAIN_NOTE_HEADLINE_MAX = 120;
export const PLAIN_NOTE_BODY_MAX_BYTES = 8192;

type Sealing = Extract<NoteRecipients, { seal: true }>;

/** What the flow needs from a surface's client, bound to its team and seat. `recipients` resolves
 *  null from a daemon older than ADR 657 (no route), which never seals. */
export interface NoteSealClient {
  recipients(publicKey?: string): Promise<NoteRecipients | null>;
  save(input: { headline: string; body?: string }): Promise<void>;
}

/** A refusal the surface renders as its own usage or state error. */
export class NoteSealError extends Error {
  constructor(
    message: string,
    readonly kind: 'cap' | 'no_machine',
  ) {
    super(message);
  }
}

/** This machine's key and the seat's machines; the key is made only once a human seat needs it. */
async function sealContext(
  client: NoteSealClient,
  env: NodeJS.ProcessEnv,
): Promise<{ key: NoteKey; rec: Sealing } | null> {
  const path = noteKeyPath(env);
  let key = loadNoteKey(path);
  let rec = await client.recipients(key?.public_key);
  if (!rec?.seal) return null;
  if (!key) {
    key = loadOrCreateNoteKey(path);
    rec = await client.recipients(key.public_key);
    if (!rec?.seal) return null;
  }
  return { key, rec };
}

function sealTo(note: OpenedNote, rec: Sealing): { headline: string; body: string } {
  const to = keyedRecipients(rec.recipients);
  if (to.length === 0) {
    throw new NoteSealError(
      "no trusted machine of yours has a note key to seal to — this one is not in your seat's set (ADR 358, ADR 657)",
      'no_machine',
    );
  }
  return { headline: SEALED_NOTE_HEADLINE, body: sealNote(note, to) };
}

/**
 * ADR 657, the save: a human seat's note leaves this machine sealed to every trusted machine of
 * theirs; an agent seat's (or an older daemon's) is saved as written. The plain-text caps are
 * checked here, because the daemon only ever sees the sealed size.
 */
export async function sealForSeat(
  client: NoteSealClient,
  note: OpenedNote,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ headline: string; body?: string }> {
  const ctx = await sealContext(client, env);
  if (!ctx) return { headline: note.headline, ...(note.body ? { body: note.body } : {}) };
  if (note.headline.length > PLAIN_NOTE_HEADLINE_MAX)
    throw new NoteSealError(
      `memory headline is ${note.headline.length} chars; the limit is ${PLAIN_NOTE_HEADLINE_MAX}`,
      'cap',
    );
  const bytes = Buffer.byteLength(note.body, 'utf8');
  if (bytes > PLAIN_NOTE_BODY_MAX_BYTES)
    throw new NoteSealError(
      `memory body is ${bytes} bytes; the limit is ${PLAIN_NOTE_BODY_MAX_BYTES}`,
      'cap',
    );
  return sealTo(note, ctx.rec);
}

export type OpenedForSeat =
  | { kind: 'plain' }
  | { kind: 'open'; headline: string; body: string; line?: string }
  | { kind: 'closed'; line: string };

/**
 * ADR 657, the read: open a sealed note with this machine's key. When the seat now trusts a keyed
 * machine the note does not reach, re-seal it to the full set; a plain-text note on a human seat
 * (saved before sealing) is sealed in place. A machine the note was not sealed to says which ones
 * it opens on.
 */
export async function openForSeat(
  client: NoteSealClient,
  mem: OpenedNote,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenedForSeat> {
  const sealed = parseSealedNote(mem.body);
  const ctx = await sealContext(client, env);
  if (!ctx)
    return sealed ? { kind: 'closed', line: closedLine(sealed.to, null) } : { kind: 'plain' };
  if (!sealed) {
    await client.save(sealTo(mem, ctx.rec));
    return {
      kind: 'open',
      headline: mem.headline,
      body: mem.body,
      line: `sealed this note to your ${machines(ctx.rec)} — it was plain text on the daemon (ADR 657)`,
    };
  }
  const opened = openNote(mem.body, ctx.key);
  if (!opened) return { kind: 'closed', line: closedLine(sealed.to, ctx.rec) };
  if (needsReseal(mem.body, keyedRecipients(ctx.rec.recipients))) {
    await client.save(sealTo(opened, ctx.rec));
    return { kind: 'open', ...opened, line: `re-sealed to your ${machines(ctx.rec)} (ADR 657)` };
  }
  return { kind: 'open', ...opened };
}

function machines(rec: Sealing): string {
  const n = keyedRecipients(rec.recipients).length;
  return n === 1 ? '1 machine' : `${n} machines`;
}

function closedLine(to: readonly { node: string }[], rec: Sealing | null): string {
  const label = (node: string) =>
    rec?.recipients.find((r) => r.node_id === node)?.label || node.slice(0, 8);
  return (
    `⚠ your note is sealed to ${to.map((s) => label(s.node)).join(', ')} — not this machine. ` +
    'Read it once on one of those and it will be sealed to this one too (ADR 657).'
  );
}
