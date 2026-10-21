import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { type Database } from '../db/open.js';
import type { SqliteDriver } from '../db/sqliteDriver.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';

withDrivers('containment', (_o, kind) => {
  /**
   * The containment property, narrowed by 3b-ii.
   *
   * 3b-i: nothing writes `messages` but `insertMessage`, and pushed events stop in `sync_log`.
   * 3b-ii: nothing writes `messages` but `insertMessage` and `foldBatch` (sync/fold.ts) — and ONLY
   * `insertMessage` moves `nodes.next_seq`. The fold copies the origin's stamp verbatim and never
   * touches the allocator; `fold.test.ts`'s first case is that falsifier. This file keeps holding
   * that the staging tables carry no counter tied to `next_seq`, and that a v50–v54 replay leaves the
   * log and every allocator alone.
   */

  /** The local state 3b-i must leave alone: the message log, and every origin's next-seq counter. */
  async function snapshot(db: Database) {
    return {
      messages: await db.get('SELECT COUNT(*) AS n FROM messages'),
      seqs: await db.all('SELECT id, next_seq FROM nodes ORDER BY id'),
    };
  }

  async function seed() {
    const db = await openTestDriver(kind);
    const team = await createTeam(db, { slug: 'revive' });
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    await insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: 'm-1',
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' },
        act: 'message',
        body: 'hi',
        ts: 1000,
      }),
    );
    return { db, team };
  }

  describe('sync containment', async () => {
    it('has the three staging tables, and they start empty', async () => {
      const { db } = await seed();

      for (const table of ['sync_log', 'sync_meta', 'sync_push_cursor']) {
        expect(await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual({ n: 0 });
      }

      await db.close();
    });

    // A SQLite ladder-replay test: the Postgres schema is one baseline + ladder (pg/drift.test).
    it.runIf(kind === 'sqlite')(
      'leaves the message log and every next_seq untouched when v50 replays',
      async () => {
        const { db } = await seed();
        const before = await snapshot(db);
        // One message, one local node that has handed out exactly one seq.
        expect(before.messages).toEqual({ n: 1 });
        expect(before.seqs).toEqual([{ id: expect.any(String), next_seq: 2 }]);

        // Rewind past v50 and replay the migration tail. v51–v53 add independent tables and an index;
        // v54 adds the origin index and the pull cursor, and touches no row; v55 adds guarded columns; v56 re-issues v54.
        await db.run("UPDATE schema_meta SET value = '49' WHERE key = 'schema_version'");
        expect(runMigrations((db as SqliteDriver).raw)).toBe(121);

        expect(await snapshot(db)).toEqual(before);
        // …and the replay did not drop what was already staged-adjacent: the tables survive it.
        expect(await db.get('SELECT COUNT(*) AS n FROM sync_log')).toEqual({ n: 0 });
        await db.close();
      },
    );

    // A SQLite ladder-replay test: the Postgres schema is one baseline + ladder (pg/drift.test).
    it.runIf(kind === 'sqlite')(
      'v54 holds (origin_node, origin_seq) unique in messages and adds the pull cursor',
      async () => {
        const { db, team } = await seed();
        const row = await db.get(
          'SELECT origin_node, origin_seq FROM messages WHERE team_id = ? LIMIT 1',
          [team.id],
        )!;
        const author = (await db.get('SELECT id FROM members LIMIT 1'))!.id;
        // A second row under the SAME origin pair must be refused by the schema, not by convention:
        // the fold (3b-ii) is a second writer, and its idempotence key is this pair, not messages.id.
        await expect(
          db.run(
            `INSERT INTO messages (id, team_id, from_member, to_kind, to_member, act, body, ts,
                                 created_at, origin_node, origin_seq)
           VALUES ('dup', ?, ?, 'team', NULL, 'message', 'x', 1, 1, ?, ?)`,
            [team.id, author, row.origin_node, row.origin_seq],
          ),
        ).rejects.toThrow(/UNIQUE|constraint|duplicate key/i);
        expect(await db.get('SELECT COUNT(*) AS n FROM sync_pull_cursor')).toEqual({ n: 0 });
        // The read side's future key (spec §"The ts-cursor defect") is indexed by the same migration.
        expect(
          await db.get(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_team_created'",
          ),
        ).toBeDefined();
        await db.close();
      },
    );

    it('stages two rows in one team that the fold cannot both write', async () => {
      const { db, team } = await seed();
      for (const id of ['node-a', 'node-b']) {
        await db.run('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)', [
          id,
          team.id,
          id,
        ]);
      }

      // ADR 335 §Decision 6 scopes envelope-id uniqueness to the ORIGIN, which is the right trade —
      // a wider scope hands one node a lever on another node's liveness. But it did not remove that
      // wedge, it MOVED it, and this test is where the move is written down rather than argued
      // about (dolly, 2026-08-31). Two origins may now stage one id in one team:
      for (const node of ['node-a', 'node-b']) {
        await db.run(
          `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
         VALUES (?, ?, ?, 1, ?, '{}', 1000)`,
          ['COLLIDE', team.id, node, node === 'node-a' ? 1 : 2],
        );
      }
      expect(await db.get('SELECT COUNT(*) AS n FROM sync_log')).toEqual({ n: 2 });

      // …and `messages.id` is a PRIMARY KEY, so the fold can write exactly one of them. 3b-ii's
      // answer (spec §"The fold's rule" 5): the second is an id_collision STOP — terminal, logged at
      // error with both origins, never silently dropped. The raw INSERT below is what the fold
      // refuses to do; it is here to show the constraint is real.
      const author = (await db.get('SELECT id FROM members LIMIT 1'))!.id;
      const fold = async (origin: string) =>
        await db.run(
          `INSERT INTO messages (id, team_id, from_member, to_kind, to_member, act, body, ts,
                                 created_at, origin_node, origin_seq)
           SELECT id, team_id, ?, 'team', NULL, 'message', 'hi', 1000, 1000, origin_node, origin_seq
             FROM sync_log WHERE origin_node = ?`,
          [author, origin],
        );

      await fold('node-a');
      await expect(fold('node-b')).rejects.toThrow(/UNIQUE|PRIMARY KEY|constraint|duplicate key/i);
      await db.close();
    });

    // A SQLite ladder-replay test: the Postgres schema is one baseline + ladder (pg/drift.test).
    it.runIf(kind === 'sqlite')(
      'keeps the staging tables free of any counter tied to nodes.next_seq',
      async () => {
        const { db } = await seed();

        // `hub_seq` is the hub's own canonical order over staged rows; `last_seq` is this machine's
        // memory of how far it has pushed. Neither is an origin's next-seq allocator, and no column
        // here may become one — that allocator lives in `nodes` and is `insertMessage`'s alone.
        for (const table of ['sync_log', 'sync_meta', 'sync_push_cursor']) {
          const columns = ((await db.all(`PRAGMA table_info(${table})`)) as { name: string }[]).map(
            (c) => c.name,
          );
          // PRAGMA on a table that does not exist returns nothing, and "nothing" contains no
          // `next_seq` — so assert the table is really there before reading the absence as a result.
          expect(columns.length).toBeGreaterThan(0);
          expect(columns).not.toContain('next_seq');
        }

        await db.close();
      },
    );
  });
});
