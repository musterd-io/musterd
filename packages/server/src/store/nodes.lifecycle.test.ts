import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { authenticateNode, bindNode, listNodes, revokeNode, rotateNode } from './nodes.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('nodes.lifecycle', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * Node lifecycle (ADR 328 §5) — "rotation keeps the node; revocation keeps the history".
   *
   * The two halves are load-bearing for different reasons. Rotation must not touch `nodes.id`, or
   * every `origin_node` already stamped in the log stops naming its origin. Revocation must not touch
   * the log, or revoking a credential becomes retro-repudiating what was said under it.
   */

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    return { db, team, ada };
  }

  describe('node lifecycle (ADR 328 §5)', async () => {
    it('rotation keeps the node id, so origin stamps survive it', async () => {
      const { db, team } = await seed();
      await bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');

      const rotated = await rotateNode(db, team.id, 'node-remote');
      expect(rotated).not.toBeNull();
      expect(rotated!.credential).toMatch(/^msnode_/);
      expect(rotated!.credential).not.toBe('msnode_aaa');

      // The old credential is dead, the new one works, and the identity is untouched — which is the
      // entire reason ADR 328 §5 made the id a ULID on the row rather than deriving it from the key.
      expect(await authenticateNode(db, team.id, 'msnode_aaa')).toBeNull();
      expect((await authenticateNode(db, team.id, rotated!.credential))?.id).toBe('node-remote');
      await db.close();
    });

    it('refuses to rotate a revoked node — re-arming a retired credential is an enrollment', async () => {
      const { db, team } = await seed();
      await bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');
      await revokeNode(db, team.id, 'node-remote');

      expect(await rotateNode(db, team.id, 'node-remote')).toBeNull();
      await db.close();
    });

    it("refuses to rotate another team's node", async () => {
      const db = await openStore();
      const one = await createTeam(db, { slug: 'one' });
      const two = await createTeam(db, { slug: 'two' });
      await bindNode(db, one.id, 'node-a', 'laptop', 'msnode_aaa', 'nick');

      expect(await rotateNode(db, two.id, 'node-a')).toBeNull();
      expect((await authenticateNode(db, one.id, 'msnode_aaa'))?.id).toBe('node-a');
      await db.close();
    });

    it('a revoked node authenticates nowhere, and revoking twice does not lie about it', async () => {
      const { db, team } = await seed();
      await bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');

      expect(await revokeNode(db, team.id, 'node-remote')).toBe(true);
      expect(await authenticateNode(db, team.id, 'msnode_aaa')).toBeNull();
      // Idempotent, but honest: the second call did not revoke anything, and says so.
      expect(await revokeNode(db, team.id, 'node-remote')).toBe(false);
      expect(await revokeNode(db, team.id, 'no-such-node')).toBe(false);
      await db.close();
    });

    it('revocation keeps the history that node attested', async () => {
      const { db, team, ada } = await seed();
      await bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');
      // A message stamped to that origin — the shape a synced event will have in 3b.
      await insertMessage(
        db,
        team.id,
        ada.id,
        null,
        makeEnvelope({
          id: 'm-1',
          team: 'revive',
          from: 'ada',
          to: { kind: 'team' as const },
          act: 'message',
          body: 'said under that credential',
          ts: 1000,
          meta: null,
        }),
      );
      await db.run("UPDATE messages SET origin_node = 'node-remote' WHERE id = 'm-1'");

      await revokeNode(db, team.id, 'node-remote');

      // The log is append-only and those events are attested history: revoking a credential is not
      // retro-repudiating what was said under it (ADR 328 §5).
      expect(
        await db.get('SELECT COUNT(*) AS n FROM messages WHERE origin_node = ?', ['node-remote']),
      ).toEqual({ n: 1 });
      // And the row itself stays, so the origin remains resolvable.
      expect(await db.get('SELECT COUNT(*) AS n FROM nodes WHERE id = ?', ['node-remote'])).toEqual(
        {
          n: 1,
        },
      );
      await db.close();
    });

    it('authenticates only a bound, unrevoked credential of the right team', async () => {
      const db = await openStore();
      const one = await createTeam(db, { slug: 'one' });
      const two = await createTeam(db, { slug: 'two' });
      await bindNode(db, one.id, 'node-a', 'laptop', 'msnode_aaa', 'nick');

      expect((await authenticateNode(db, one.id, 'msnode_aaa'))?.label).toBe('laptop');
      // A node speaks only for the team it was admitted to — ADR 325's one team, one authority.
      expect(await authenticateNode(db, two.id, 'msnode_aaa')).toBeNull();
      expect(await authenticateNode(db, one.id, 'msnode_wrong')).toBeNull();
      expect(await authenticateNode(db, one.id, '')).toBeNull();
      await db.close();
    });

    it('never returns a credential or a hash in a listing', async () => {
      const { db, team, ada } = await seed();
      // The daemon's own row is unenrolled; the remote one is bound.
      await insertMessage(
        db,
        team.id,
        ada.id,
        null,
        makeEnvelope({
          id: 'm-1',
          team: 'revive',
          from: 'ada',
          to: { kind: 'team' as const },
          act: 'message',
          body: 'hi',
          ts: 1000,
          meta: null,
        }),
      );
      await bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_secret-value', 'nick');

      const listed = await listNodes(db, team.id);
      expect(listed).toHaveLength(2);
      expect(JSON.stringify(listed)).not.toContain('msnode_secret-value');
      expect(JSON.stringify(listed)).not.toContain('credential_hash');

      const remote = listed.find((n) => n.id === 'node-remote')!;
      expect(remote.credential_prefix).toBe('msnode_');
      expect(remote.enrolled_at).not.toBeNull();

      // The unenrolled local row reads as unenrolled rather than as missing — "enrolled" is a state
      // to check, not something the row's existence guarantees (ADR 331 §Consequences).
      const local = listed.find((n) => n.id !== 'node-remote')!;
      expect(local.credential_prefix).toBeNull();
      expect(local.enrolled_at).toBeNull();
      await db.close();
    });
  });
});
