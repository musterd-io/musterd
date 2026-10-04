import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDriver } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('originStamp', (o, kind) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    return { db, team, ada };
  }

  async function env(id: string, ts: number, meta: Record<string, unknown> | null = null) {
    return makeEnvelope({
      id,
      team: 'revive',
      from: 'ada',
      to: { kind: 'team' as const },
      act: 'message',
      body: 'hi',
      ts,
      meta,
    });
  }

  async function seqsFor(db: ReturnType<typeof openDb>, teamId: string) {
    return await db.all(
      'SELECT origin_node, origin_seq FROM messages WHERE team_id = ? ORDER BY origin_seq ASC',
      [teamId],
    );
  }

  describe('the (origin_node, origin_seq) stamp (ADR 331)', async () => {
    // Eval (i): gaplessness — N inserts yield exactly 1..N for this node, no duplicates, no holes.
    it('stamps N inserts as exactly the sequence 1..N against one node row', async () => {
      const { db, team, ada } = await seed();
      for (let i = 1; i <= 5; i++)
        await insertMessage(db, team.id, ada.id, null, await env(`m-${i}`, 1000 + i));
      const rows = await seqsFor(db, team.id);
      expect(rows.map((r) => r.origin_seq)).toEqual([1, 2, 3, 4, 5]);
      const nodes = new Set(rows.map((r) => r.origin_node));
      expect(nodes.size).toBe(1);
      const node = await db.get('SELECT id, next_seq FROM nodes WHERE team_id = ?', [team.id]);
      expect(node?.id).toBe([...nodes][0]);
      expect(node?.next_seq).toBe(6);
    });

    // Eval (ii): a failed insert burns no number — the falsifier for §Decision 2's transaction.
    it('a failed insert (duplicate envelope id) leaves next_seq unchanged and no hole', async () => {
      const { db, team, ada } = await seed();
      await insertMessage(db, team.id, ada.id, null, await env('m-1', 1001));
      await insertMessage(db, team.id, ada.id, null, await env('m-2', 1002));
      await expect(
        insertMessage(db, team.id, ada.id, null, await env('m-2', 1003)),
      ).rejects.toThrow();
      const node = await db.get('SELECT next_seq FROM nodes WHERE team_id = ?', [team.id]);
      expect(node?.next_seq).toBe(3);
      await insertMessage(db, team.id, ada.id, null, await env('m-3', 1004));
      expect((await seqsFor(db, team.id)).map((r) => r.origin_seq)).toEqual([1, 2, 3]);
    });

    // Eval (iii): monotone across restart — the counter is a column, not process state.
    // A file reopened is a SQLite fact; the Postgres double is one in-process instance.
    it.runIf(kind === 'sqlite')(
      'resumes past the pre-restart maximum after close and reopen',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'musterd-origin-'));
        const file = join(dir, 'db.sqlite');
        try {
          const db1 = openDriver(file);
          const team = await createTeam(db1, { slug: 'revive' });
          const ada = (await addMember(db1, team, { name: 'ada', kind: 'agent' })).row;
          await insertMessage(db1, team.id, ada.id, null, await env('m-1', 1001));
          await insertMessage(db1, team.id, ada.id, null, await env('m-2', 1002));
          await db1.close();
          const db2 = openDriver(file);
          await insertMessage(db2, team.id, ada.id, null, await env('m-3', 1003));
          expect((await seqsFor(db2, team.id)).map((r) => r.origin_seq)).toEqual([1, 2, 3]);
          await db2.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    // Eval (v): no caller-supplied origin — the same falsifier `from_provenance` warrants.
    it('ignores origin fields arriving in envelope meta; the stamp is server-derived', async () => {
      const { db, team, ada } = await seed();
      await insertMessage(
        db,
        team.id,
        ada.id,
        null,
        await env('m-1', 1001, { origin_node: 'evil', origin_seq: 999 }),
      );
      const row = (await seqsFor(db, team.id))[0]!;
      expect(row.origin_seq).toBe(1);
      expect(row.origin_node).not.toBe('evil');
      const node = await db.get('SELECT id FROM nodes WHERE team_id = ?', [team.id]);
      expect(row.origin_node).toBe(node?.id);
    });

    // Two teams on one daemon are two node identities with two independent streams (§Decision 1).
    it('keeps independent per-team sequences on a daemon hosting two teams', async () => {
      const db = await openStore();
      const t1 = await createTeam(db, { slug: 'one' });
      const t2 = await createTeam(db, { slug: 'two' });
      const a1 = (await addMember(db, t1, { name: 'ada', kind: 'agent' })).row;
      const a2 = (await addMember(db, t2, { name: 'ada', kind: 'agent' })).row;
      await insertMessage(db, t1.id, a1.id, null, await env('m-1', 1001));
      await insertMessage(db, t2.id, a2.id, null, await env('m-2', 1002));
      await insertMessage(db, t1.id, a1.id, null, await env('m-3', 1003));
      expect((await seqsFor(db, t1.id)).map((r) => r.origin_seq)).toEqual([1, 2]);
      expect((await seqsFor(db, t2.id)).map((r) => r.origin_seq)).toEqual([1]);
      const n1 = (await seqsFor(db, t1.id))[0]!.origin_node;
      const n2 = (await seqsFor(db, t2.id))[0]!.origin_node;
      expect(n1).not.toBe(n2);
      await db.close();
    });
  });
});
