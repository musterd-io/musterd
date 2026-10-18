import { SEALED_NOTE_HEADLINE } from '@musterd/protocol';
import { generateNoteKey, sealNote } from '@musterd/protocol/note-seal';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { addMember } from './members.js';
import {
  assertNoteShape,
  clearMemory,
  getMemory,
  MEMORY_BODY_MAX_BYTES,
  MEMORY_HEADLINE_MAX_CHARS,
  memoryEnvelope,
  memoryProvenance,
  noteRecipients,
  parseWriter,
  saveMemory,
  setNodeNoteKey,
} from './memory.js';
import { localNodeForTeam } from './messages.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const memberId = (await addMember(db, team, { name: 'stanley', kind: 'agent' })).row.id;
  return { db, memberId };
}

withDrivers('memory', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('seat memory (ADR 093)', async () => {
    it('save → get round-trips headline/body/saved_at; envelope() has no body', async () => {
      const { db, memberId } = await seed();
      await saveMemory(db, memberId, { headline: 'h', body: 'b' });
      const m = (await getMemory(db, memberId))!;
      expect(m.headline).toBe('h');
      expect(m.body).toBe('b');
      expect(typeof m.saved_at).toBe('number');
      const env = (await memoryEnvelope(db, memberId))!;
      expect(env).toEqual({ headline: 'h', saved_at: expect.any(Number), size_bytes: 1 });
      expect('body' in env).toBe(false);
    });

    it('is last-write-wins (single row per member)', async () => {
      const { db, memberId } = await seed();
      await saveMemory(db, memberId, { headline: 'first', body: 'one' });
      await saveMemory(db, memberId, { headline: 'second', body: 'two' });
      const m = (await getMemory(db, memberId))!;
      expect(m.headline).toBe('second');
      expect(m.body).toBe('two');
    });

    it('rejects a body over 8192 bytes with the named limit', async () => {
      const { db, memberId } = await seed();
      await expect(
        saveMemory(db, memberId, { headline: 'h', body: 'x'.repeat(8193) }),
      ).rejects.toThrow(/8192/);
      try {
        await saveMemory(db, memberId, { headline: 'h', body: 'x'.repeat(8193) });
      } catch (e) {
        expect((e as MusterdError).code).toBe('bad_request');
      }
    });

    it('rejects a headline over 120 chars with the named limit', async () => {
      const { db, memberId } = await seed();
      await expect(
        saveMemory(db, memberId, { headline: 'x'.repeat(121), body: 'b' }),
      ).rejects.toThrow(/120/);
    });

    it('rejects an empty headline', async () => {
      const { db, memberId } = await seed();
      await expect(saveMemory(db, memberId, { headline: '', body: 'b' })).rejects.toThrow(
        MusterdError,
      );
    });

    it('accepts a body exactly at the cap and a headline exactly at the cap', async () => {
      const { db, memberId } = await seed();
      await expect(
        saveMemory(db, memberId, {
          headline: 'x'.repeat(MEMORY_HEADLINE_MAX_CHARS),
          body: 'x'.repeat(MEMORY_BODY_MAX_BYTES),
        }),
      ).resolves.not.toBeNull();
    });

    it('clear removes the row; get/envelope return null after, and reports whether a row existed', async () => {
      const { db, memberId } = await seed();
      await saveMemory(db, memberId, { headline: 'h', body: 'b' });
      expect(await clearMemory(db, memberId)).toBe(true);
      expect(await getMemory(db, memberId)).toBeNull();
      expect(await memoryEnvelope(db, memberId)).toBeNull();
      expect(await clearMemory(db, memberId)).toBe(false); // idempotent — nothing left to clear
    });

    it('returns null for a seat that has never saved', async () => {
      const { db, memberId } = await seed();
      expect(await getMemory(db, memberId)).toBeNull();
      expect(await memoryEnvelope(db, memberId)).toBeNull();
    });

    it('size_bytes counts UTF-8 bytes, not code units', async () => {
      const { db, memberId } = await seed();
      await saveMemory(db, memberId, { headline: 'h', body: '€€' }); // 3 bytes each → 6
      expect((await memoryEnvelope(db, memberId))!.size_bytes).toBe(6);
    });

    it('caps the body on UTF-8 byte length, not code-unit length', async () => {
      const { db, memberId } = await seed();
      // 2731 '€' = 8193 bytes but only 2731 code units — must still reject on the byte cap.
      await expect(
        saveMemory(db, memberId, { headline: 'h', body: '€'.repeat(2731) }),
      ).rejects.toThrow(/8192/);
    });
  });
});

describe('memoryProvenance (ADR 654)', () => {
  const here = { surface: 'claude-code', workspace: 'lazara@feat/x', node: 'N1', machine: 'mac-1' };

  it('a save before the stamp reads as not recorded, never as suspect', () => {
    expect(memoryProvenance('agent', null, here)).toEqual({
      writer: null,
      suspect: false,
      line: 'who saved this note was not recorded (saved before ADR 654)',
    });
  });

  it('the same folder on the same machine is a plain fact, whatever the branch or surface', () => {
    const p = memoryProvenance('agent', { ...here, workspace: 'lazara', surface: 'cli' }, here);
    expect(p.suspect).toBe(false);
    expect(p.line).toBe('last saved from lazara on mac-1 by cli');
  });

  it("an agent seat's note saved from another folder or machine is suspect, naming both places", () => {
    const folder = memoryProvenance('agent', { ...here, workspace: 'dolly@main' }, here);
    expect(folder.suspect).toBe(true);
    expect(folder.line).toMatch(
      /^your note was last saved from dolly on mac-1 by claude-code, not this seat's folder \(lazara\)/,
    );
    const machine = memoryProvenance('agent', { ...here, node: 'N2', machine: 'mac-2' }, here);
    expect(machine.suspect).toBe(true);
    expect(machine.line).toMatch(/not this machine \(mac-1\)/);
  });

  it("a human seat's note and an unknown reader get the fact and no verdict", () => {
    const elsewhere = { ...here, node: 'N2', machine: 'mac-2', workspace: 'nick' };
    expect(memoryProvenance('human', elsewhere, here).suspect).toBe(false);
    expect(memoryProvenance('agent', elsewhere, null).suspect).toBe(false);
  });

  it('a writer with no folder is another place to a reader that has one (amended 2026-10-18)', () => {
    const { workspace: _w, ...noFolder } = here;
    const p = memoryProvenance('agent', noFolder, here);
    expect(p.suspect).toBe(true);
    expect(p.line).toMatch(
      /^your note was last saved from an unnamed folder on mac-1 by claude-code, not this seat's folder \(lazara\)/,
    );
  });

  it('a reader with no folder compares the machine only', () => {
    const { workspace: _w, ...noFolder } = here;
    expect(memoryProvenance('agent', here, noFolder).suspect).toBe(false);
    expect(memoryProvenance('agent', noFolder, noFolder).suspect).toBe(false);
    expect(memoryProvenance('agent', { ...here, node: 'N2' }, noFolder).suspect).toBe(true);
  });

  it('parseWriter keeps a well-formed stamp and drops anything else', () => {
    expect(parseWriter(JSON.stringify(here))).toEqual(here);
    expect(parseWriter(here)).toEqual(here);
    expect(parseWriter('{not json')).toBeNull();
    expect(parseWriter({ surface: 'x', extra: 1 })).toBeNull();
    expect(parseWriter(undefined)).toBeNull();
  });
});

withDrivers('memory · sealed notes (ADR 657)', (o) => {
  const key = generateNoteKey();
  const sealed = {
    headline: SEALED_NOTE_HEADLINE,
    body: sealNote({ headline: 'h', body: 'b' }, [{ node: 'n', pk: key.public_key }]),
  };

  it("assertNoteShape: a human's note arrives sealed with the fixed headline; an agent's never sealed", () => {
    expect(() => assertNoteShape('human', sealed)).not.toThrow();
    expect(() => assertNoteShape('human', { headline: 'h', body: 'b' })).toThrow(/sealed/);
    expect(() => assertNoteShape('human', { ...sealed, headline: 'leaks' })).toThrow(/headline/);
    expect(() => assertNoteShape('agent', { headline: 'h', body: 'b' })).not.toThrow();
    expect(() => assertNoteShape('agent', sealed)).toThrow(/not sealed/);
  });

  it('a sealed body may exceed the plain-text cap, up to its own', async () => {
    const db = await o();
    const team = await createTeam(db, { slug: 'revive' });
    const id = (await addMember(db, team, { name: 'nick', kind: 'human' })).row.id;
    const big = sealNote({ headline: 'h', body: 'x'.repeat(MEMORY_BODY_MAX_BYTES) }, [
      { node: 'n', pk: key.public_key },
    ]);
    expect(Buffer.byteLength(big)).toBeGreaterThan(MEMORY_BODY_MAX_BYTES);
    await saveMemory(db, id, { headline: SEALED_NOTE_HEADLINE, body: big });
    expect((await getMemory(db, id))?.body).toBe(big);
  });

  it('noteRecipients: the trusted set with keys; the asking node when unbound; no seal for an agent', async () => {
    const db = await o();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    const { id: local } = await localNodeForTeam(db, team.id);
    expect(await noteRecipients(db, ada, local)).toEqual({ seal: false });

    // Unbound: the asking node is the whole set, keyless until it registers.
    expect(await noteRecipients(db, nick, local)).toMatchObject({
      seal: true,
      node_id: local,
      recipients: [{ node_id: local, public_key: null }],
    });
    await setNodeNoteKey(db, team.id, local, key.public_key, 'nick');
    await setNodeNoteKey(db, team.id, local, key.public_key, 'nick'); // a repeat writes nothing
    const rows = await db.all<{ detail: string }>(
      "SELECT detail FROM audit WHERE action = 'node.note_key_set'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).not.toContain(key.public_key);

    // Bound to two nodes: both listed, the second keyless.
    await db.run('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)', [
      'n-mini',
      team.id,
      'mini',
    ]);
    for (const [node, at] of [
      [local, 1],
      ['n-mini', 2],
    ] as const)
      await db.run(
        'INSERT INTO seat_nodes (member_id, team_id, node_id, bound_at) VALUES (?, ?, ?, ?)',
        [nick.id, team.id, node, at],
      );
    expect(await noteRecipients(db, nick, local)).toEqual({
      seal: true,
      node_id: local,
      recipients: [
        { node_id: local, label: expect.any(String), public_key: key.public_key },
        { node_id: 'n-mini', label: 'mini', public_key: null },
      ],
    });
  });
});
