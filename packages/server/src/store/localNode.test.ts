import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDb } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('localNode', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * The `local_node` marker (increment 3a) — which `nodes` row is THIS daemon's, per team.
   *
   * Increment 2 picked it with `ORDER BY id LIMIT 1`, whose own comment conceded the assumption:
   * "before increment 3 lands enrollment there is exactly one row per team". Enrollment is precisely
   * what adds the second row, and a remote ULID that happens to sort lower would then take over our
   * stamp — our sequence gains a permanent hole, theirs gains numbers naming events it never wrote.
   * That is the loss-versus-silence ambiguity ADR 331 exists to prevent, so the marker lands here,
   * ahead of any code path that can insert a remote row.
   */

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    return { db, team, ada };
  }

  async function env(id: string, ts: number) {
    return makeEnvelope({
      id,
      team: 'revive',
      from: 'ada',
      to: { kind: 'team' as const },
      act: 'message',
      body: 'hi',
      ts,
      meta: null,
    });
  }

  async function localNodeId(db: ReturnType<typeof openDb>, teamId: string): Promise<string> {
    return (await db.get('SELECT node_id FROM local_node WHERE team_id = ?', [teamId]))!.node_id;
  }

  describe('local_node — the marker that survives a second node row', async () => {
    it('marks the row v47 minted, one per team', async () => {
      const { db, team, ada } = await seed();
      await insertMessage(db, team.id, ada.id, null, await env('m-1', 1001));

      const stamped = (await db.get('SELECT origin_node FROM messages WHERE id = ?', ['m-1']))!
        .origin_node;
      expect(await localNodeId(db, team.id)).toBe(stamped);
      await db.close();
    });

    it('stamps OUR node even when a remote row sorts below it', async () => {
      const { db, team, ada } = await seed();
      await insertMessage(db, team.id, ada.id, null, await env('m-1', 1001));
      const ours = await localNodeId(db, team.id);

      // An id that sorts strictly below ours — exactly what `ORDER BY id LIMIT 1` would prefer.
      // All-zeros rather than a mutated copy of `ours`: a real ULID's leading character is already
      // '0' for any timestamp this century, so patching the first byte yields the same string back.
      const lower = '0'.repeat(26);
      expect(lower < ours).toBe(true);
      await db.run('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)', [
        lower,
        team.id,
        'someone-elses-laptop',
      ]);

      await insertMessage(db, team.id, ada.id, null, await env('m-2', 1002));

      const stamped = (await db.get('SELECT origin_node FROM messages WHERE id = ?', ['m-2']))!
        .origin_node;
      expect(stamped).toBe(ours);

      // And the remote node's counter is untouched — a stolen stamp corrupts two sequences, not one.
      expect((await db.get('SELECT next_seq FROM nodes WHERE id = ?', [lower]))!.next_seq).toBe(1);
      await db.close();
    });

    it('keeps one marker per team on a daemon hosting two', async () => {
      const db = await openStore();
      const t1 = await createTeam(db, { slug: 'one' });
      const t2 = await createTeam(db, { slug: 'two' });
      const a1 = (await addMember(db, t1, { name: 'ada', kind: 'agent' })).row;
      const a2 = (await addMember(db, t2, { name: 'ada', kind: 'agent' })).row;
      await insertMessage(db, t1.id, a1.id, null, await env('m-1', 1001));
      await insertMessage(db, t2.id, a2.id, null, await env('m-2', 1002));

      expect(await localNodeId(db, t1.id)).not.toBe(await localNodeId(db, t2.id));
      expect(await db.get('SELECT COUNT(*) AS n FROM local_node')).toEqual({ n: 2 });
      await db.close();
    });
  });
});
