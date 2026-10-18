import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSealedNote, SEALED_NOTE_HEADLINE, SEALED_NOTE_PREFIX } from './claim-handshake.js';
import {
  generateNoteKey,
  keyedRecipients,
  loadNoteKey,
  loadOrCreateNoteKey,
  needsReseal,
  noteKeyPath,
  openForSeat,
  openNote,
  sealForSeat,
  sealNote,
} from './note-seal.js';

function key(name: string) {
  return loadOrCreateNoteKey(join(mkdtempSync(join(tmpdir(), 'note-key-')), name));
}

const NOTE = { headline: 'mid-flight on lane 6', body: 'CANARY-human-body ✓' };

describe('note seal (ADR 657)', () => {
  it('a recipient opens what was sealed to it; the stored string never holds the plain text', () => {
    const a = key('a.json');
    const sealed = sealNote(NOTE, [{ node: 'nA', pk: a.public_key }]);
    expect(sealed.startsWith(SEALED_NOTE_PREFIX)).toBe(true);
    expect(sealed).not.toContain('CANARY');
    expect(
      Buffer.from(sealed.slice(SEALED_NOTE_PREFIX.length), 'base64url').toString(),
    ).not.toContain('CANARY');
    expect(openNote(sealed, a)).toEqual(NOTE);
    expect(parseSealedNote(sealed)?.to.map((s) => s.node)).toEqual(['nA']);
  });

  it('every machine it was sealed to opens it; one it was not sealed to cannot', () => {
    const [a, b, c] = [key('a.json'), key('b.json'), key('c.json')];
    const sealed = sealNote(NOTE, [
      { node: 'nA', pk: a.public_key },
      { node: 'nB', pk: b.public_key },
    ]);
    expect(openNote(sealed, a)).toEqual(NOTE);
    expect(openNote(sealed, b)).toEqual(NOTE);
    expect(openNote(sealed, c)).toBeNull();
  });

  it('a stanza relabelled to another key, or a tampered ciphertext, does not open', () => {
    const [a, c] = [key('a.json'), key('c.json')];
    const note = parseSealedNote(sealNote(NOTE, [{ node: 'nA', pk: a.public_key }]))!;
    const relabel = { ...note, to: [{ ...note.to[0]!, pk: c.public_key }] };
    const enc = (n: object) =>
      SEALED_NOTE_PREFIX + Buffer.from(JSON.stringify(n)).toString('base64url');
    expect(openNote(enc(relabel), c)).toBeNull();
    const ct = Buffer.from(note.ct, 'base64url');
    ct[0] = ct[0]! ^ 1;
    expect(openNote(enc({ ...note, ct: ct.toString('base64url') }), a)).toBeNull();
  });

  it('plain text and garbage are not sealed notes', () => {
    const a = key('a.json');
    expect(parseSealedNote('just a note')).toBeNull();
    expect(parseSealedNote(`${SEALED_NOTE_PREFIX}not-json`)).toBeNull();
    expect(openNote('just a note', a)).toBeNull();
  });

  it('needsReseal: a newly trusted machine, or a changed key, asks for a re-seal; a dropped one does not', () => {
    const [a, b] = [key('a.json'), key('b.json')];
    const sealed = sealNote(NOTE, [{ node: 'nA', pk: a.public_key }]);
    expect(needsReseal(sealed, [{ node: 'nA', pk: a.public_key }])).toBe(false);
    expect(needsReseal(sealed, [])).toBe(false);
    expect(
      needsReseal(sealed, [
        { node: 'nA', pk: a.public_key },
        { node: 'nB', pk: b.public_key },
      ]),
    ).toBe(true);
    expect(needsReseal(sealed, [{ node: 'nA', pk: b.public_key }])).toBe(true);
    expect(needsReseal('plain text', [{ node: 'nA', pk: a.public_key }])).toBe(true);
  });

  it('keyedRecipients skips a trusted machine with no key yet', () => {
    expect(
      keyedRecipients([
        { node_id: 'nA', label: 'air', public_key: 'k'.repeat(43) },
        { node_id: 'nB', label: 'mini', public_key: null },
      ]),
    ).toEqual([{ node: 'nA', pk: 'k'.repeat(43) }]);
  });

  it('the key file is made once, mode 0600, and loads back to the same key', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'note-key-')), 'nested', 'note-key.json');
    expect(loadNoteKey(path)).toBeNull();
    const made = loadOrCreateNoteKey(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateNoteKey(path).public_key).toBe(made.public_key);
    expect(made.public_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('noteKeyPath: the override, else beside the config', () => {
    expect(noteKeyPath({ MUSTERD_NOTE_KEY: '/x/k.json' })).toBe('/x/k.json');
    expect(noteKeyPath({ MUSTERD_CONFIG: '/h/.musterd/config.json' })).toBe(
      '/h/.musterd/note-key.json',
    );
  });
});

describe('openForSeat / sealForSeat (ADR 657)', () => {
  const env = { MUSTERD_NOTE_KEY: '' };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-seal-'));
    env.MUSTERD_NOTE_KEY = join(dir, 'note-key.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fakeDaemon(other: { public_key: string } | null) {
    const saved: { headline: string; body?: string }[] = [];
    let mine = '';
    const http = {
      recipients: async (publicKey?: string) => {
        if (publicKey) mine = publicKey;
        return {
          seal: true as const,
          node_id: 'nA',
          recipients: [
            { node_id: 'nA', label: 'air', public_key: mine || null },
            { node_id: 'nB', label: 'mini', public_key: other?.public_key ?? null },
          ],
        };
      },
      save: async (input: { headline: string; body?: string }) => {
        saved.push(input);
      },
    };
    return { http, saved };
  }

  it('re-seals to a newly trusted machine once it has a key, and only then', async () => {
    const mini = generateNoteKey();
    const before = fakeDaemon(null); // mini is trusted but has never registered a key
    const sealed = await sealForSeat(before.http, { headline: 'h', body: 'b' }, env);
    expect(parseSealedNote(sealed.body!)!.to.map((s) => s.node)).toEqual(['nA']);
    const quiet = await openForSeat(before.http, sealed as never, env);
    expect(quiet).toEqual({ kind: 'open', headline: 'h', body: 'b' });
    expect(before.saved).toEqual([]);

    const after = fakeDaemon(mini); // mini has registered its key now
    const opened = await openForSeat(after.http, sealed as never, env);
    expect(opened).toMatchObject({ kind: 'open', headline: 'h', body: 'b' });
    expect((opened as { line?: string }).line).toContain('re-sealed to your 2 machines');
    expect(parseSealedNote(after.saved[0]!.body!)!.to.map((s) => s.node)).toEqual(['nA', 'nB']);
  });

  it('an agent seat (no seal) saves and reads as written, and makes no key', async () => {
    const http = {
      recipients: async () => ({ seal: false as const }),
      save: async () => {},
    };
    expect(await sealForSeat(http, { headline: 'h', body: 'b' }, env)).toEqual({
      headline: 'h',
      body: 'b',
    });
    expect(await openForSeat(http, { headline: 'h', body: 'b' }, env)).toEqual({
      kind: 'plain',
    });
    expect(() => statSync(env.MUSTERD_NOTE_KEY)).toThrow();
  });

  it('a sealed note this machine cannot reach names the machines it opens on', async () => {
    const elsewhere = generateNoteKey();
    const body = sealNote({ headline: 'h', body: 'b' }, [{ node: 'nB', pk: elsewhere.public_key }]);
    const { http } = fakeDaemon(elsewhere);
    const r = await openForSeat(http, { headline: SEALED_NOTE_HEADLINE, body }, env);
    expect(r).toEqual({ kind: 'closed', line: expect.stringContaining('sealed to mini') });
  });
});
