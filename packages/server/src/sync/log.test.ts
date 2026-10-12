import { PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createTeam } from '../store/teams.js';
import {
  hubHead,
  highestContiguousSeq,
  ingestBatch,
  laneGenesis,
  SyncDuplicateIdError,
  SyncGapError,
  SyncOriginError,
} from './log.js';

withDrivers('log', (_o, kind) => {
  async function seed() {
    const db = await openTestDriver(kind);
    const team = await createTeam(db, { slug: 'revive' });
    for (const id of ['node-a', 'node-b']) {
      await db.run('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)', [
        id,
        team.id,
        id,
      ]);
    }
    return { db, team };
  }

  async function ev(node: string, seq: number, id = `${node}-${seq}`) {
    return {
      envelope: {
        id,
        v: PROTOCOL_VERSION,
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' as const },
        act: 'message' as const,
        body: 'hi',
        ts: 1000 + seq,
      },
      origin_node: node,
      origin_seq: seq,
      from_provenance: null,
    };
  }

  const staged = async (db: ReturnType<typeof openDb>) =>
    await db.get('SELECT COUNT(*) AS n FROM sync_log');

  describe('hub ingest (ADR 325)', async () => {
    it("refuses a batch carrying another node's origin", async () => {
      const { db, team } = await seed();
      // ADR 328 §1: an event's origin is a fact the hub authenticated, not a string the sender chose.
      // Without this check that sentence is aspiration — one compromised machine could mint events
      // attributed to any other.
      await expect(ingestBatch(db, team.id, 'node-a', [await ev('node-b', 1)])).rejects.toThrow(
        SyncOriginError,
      );
      expect(await staged(db)).toEqual({ n: 0 });
      await db.close();
    });

    it('refuses a node that is not a member of the team it is pushing to', async () => {
      const { db } = await seed();
      const other = await createTeam(db, { slug: 'dawn' });
      // `nodes.id` is a GLOBAL primary key while a node belongs to exactly one team, so an
      // authenticated node id proves identity but NOT that it may write to this team's log. The same
      // global-PK-versus-team-scope confusion was the one confirmed hole in increment 3a (izzo,
      // 2026-08-27); it does not get to recur one increment later.
      await expect(ingestBatch(db, other.id, 'node-a', [await ev('node-a', 1)])).rejects.toThrow(
        SyncOriginError,
      );
      expect(await staged(db)).toEqual({ n: 0 });
      await db.close();
    });

    it('refuses a gap and names the resume point', async () => {
      const { db, team } = await seed();
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1)]);
      try {
        await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 3)]);
        throw new Error('expected a gap refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(SyncGapError);
        // A pusher that cannot self-correct retries the same rejected batch forever.
        expect((err as SyncGapError).expectedSeq).toBe(2);
      }
      await db.close();
    });

    it('is idempotent — a replayed batch inserts nothing and still acks', async () => {
      const { db, team } = await seed();
      const first = await ingestBatch(db, team.id, 'node-a', [
        await ev('node-a', 1),
        await ev('node-a', 2),
      ]);
      expect(first.accepted).toBe(2);
      // A lost ack is the realistic case; the pusher resends the same batch.
      const replay = await ingestBatch(db, team.id, 'node-a', [
        await ev('node-a', 1),
        await ev('node-a', 2),
      ]);
      expect(replay.accepted).toBe(0);
      expect(replay.hub_seq_high).toBe(first.hub_seq_high);
      expect(await staged(db)).toEqual({ n: 2 });
      await db.close();
    });

    it('accepts the unheld tail of a partially replayed batch', async () => {
      const { db, team } = await seed();
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1)]);
      // The pusher's cursor lagged: it resends 1 (held) alongside 2 (new). Skipping the replay must
      // not be read as a gap, and the new tail must still land.
      const res = await ingestBatch(db, team.id, 'node-a', [
        await ev('node-a', 1),
        await ev('node-a', 2),
      ]);
      expect(res.accepted).toBe(1);
      expect(await highestContiguousSeq(db, 'node-a')).toBe(2);
      await db.close();
    });

    it('keeps two origins independent and hub_seq dense across them', async () => {
      const { db, team } = await seed();
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1)]);
      await ingestBatch(db, team.id, 'node-b', [await ev('node-b', 1), await ev('node-b', 2)]);
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 2)]);

      const rows = await db.all(
        'SELECT origin_node, origin_seq, hub_seq FROM sync_log ORDER BY hub_seq',
      );
      // Order of INGEST, not of ts — wall-clock across machines is what ADR 331 §Context says cannot
      // be trusted; arrival at the one authority is a fact the authority observed.
      expect(rows.map((r) => r.hub_seq)).toEqual([1, 2, 3, 4]);
      expect(rows.map((r) => `${r.origin_node}:${r.origin_seq}`)).toEqual([
        'node-a:1',
        'node-b:1',
        'node-b:2',
        'node-a:2',
      ]);
      expect(await hubHead(db, team.id)).toBe(4);
      await db.close();
    });

    it('starts hub_seq at 1 and leaves next_hub_seq one ahead', async () => {
      const { db, team } = await seed();
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1)]);
      // The allocator hands out the PRE-increment value. Copying the schema's DEFAULT 1 into the
      // insert instead would hand out hub_seq 1 twice — the shape of the bug ADR 331's first draft
      // carried, and the reason idx_sync_log_hub is UNIQUE.
      expect(await db.get('SELECT hub_seq FROM sync_log')).toEqual({ hub_seq: 1 });
      expect(await db.get('SELECT next_hub_seq FROM sync_meta')).toEqual({ next_hub_seq: 2 });
      await db.close();
    });

    it('a rejected batch stages nothing — the refusal rolls back', async () => {
      const { db, team } = await seed();
      // Second event gaps: better-sqlite3 COMMITS a transaction whose function RETURNS, so the
      // refusal has to throw. A half-applied batch would leave a hole the pusher cannot see.
      await expect(
        ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1), await ev('node-a', 3)]),
      ).rejects.toThrow(SyncGapError);
      expect(await staged(db)).toEqual({ n: 0 });
      expect(await hubHead(db, team.id)).toBe(0);
      await db.close();
    });

    it('refuses a distinct event that reuses THIS origin\u2019s staged envelope id', async () => {
      const { db, team } = await seed();
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1)]);
      // seq 2 carrying seq 1's envelope id is not a replay — the idempotence key (origin_node,
      // origin_seq) says these are different events. Swallowing it would advance the origin's
      // sequence past an event the hub never stored: silent loss wearing an ack. An origin cannot
      // honestly mint one id twice (messages.id is its own local PK), so this is its own corruption
      // and wedging only itself is the correct blast radius.
      await expect(
        ingestBatch(db, team.id, 'node-a', [await ev('node-a', 2, 'node-a-1')]),
      ).rejects.toThrow(SyncDuplicateIdError);
      expect(await staged(db)).toEqual({ n: 1 });
      // And the refusal took the allocated hub_seq back down with it, so the order stays dense.
      expect(await hubHead(db, team.id)).toBe(1);
      expect(await db.get('SELECT next_hub_seq FROM sync_meta')).toEqual({ next_hub_seq: 2 });
      await db.close();
    });

    it('lets a DIFFERENT origin stage the same envelope id — one node cannot wedge another', async () => {
      const { db, team } = await seed();
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1, 'COLLIDE')]);

      // dolly, 2026-08-28 (#1102 required A): with a global `id` PRIMARY KEY this threw, and because
      // the batch is refused, the route answers non-409, pushTeam throws, and the cursor correctly
      // does NOT move — so the next tick resends the identical batch into the identical constraint.
      // That node's sync is dead until someone operates on the hub's database, signalled only by a
      // warn line indistinguishable from being offline. Envelope ids are minted by the origin, so a
      // hostile enrolled node chooses the collision and it costs one push.
      //
      // Uniqueness is scoped to (origin_node, id): an origin is answerable for its own ids and for
      // nobody else's. Scoping to the TEAM would have narrowed the wedge to same-team nodes, which is
      // exactly the population federation exists to serve.
      expect(
        (await ingestBatch(db, team.id, 'node-b', [await ev('node-b', 1, 'COLLIDE')])).accepted,
      ).toBe(1);
      expect(await staged(db)).toEqual({ n: 2 });
      expect(await hubHead(db, team.id)).toBe(2);
      await db.close();
    });

    it('an origin that restages one seq under a different id is silently acked, not refused', async () => {
      const { db, team } = await seed();
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1, 'node-a-1')]);

      // The guard above is ASYMMETRIC, and this test is the falsifier for saying so (dolly,
      // 2026-08-31). An id reused under a NEW seq is refused terminally and loudly; the same seq
      // restaged under a DIFFERENT id is swallowed by the `origin_seq < expected` replay branch
      // before anything compares ids. The hub keeps its version, acks, and the origin advances its
      // cursor believing the newer body landed — the same corruption at the same source as the case
      // above, treated the opposite way: one screams, one is silent loss wearing an ack.
      //
      // It is left this way on purpose. Comparing ids on the replay path would make every lost ack
      // a potential refusal, and an origin cannot honestly mint two bodies under one seq; 3b-ii's
      // fold is where a divergent replay becomes detectable against a stored payload.
      const restaged = await ingestBatch(db, team.id, 'node-a', [
        await ev('node-a', 1, 'node-a-1-REWRITTEN'),
      ]);
      expect(restaged.accepted).toBe(0);
      expect(await staged(db)).toEqual({ n: 1 });
      expect(await db.get('SELECT id FROM sync_log')).toEqual({ id: 'node-a-1' });
      await db.close();
    });

    it('a batch that throws mid-loop leaves the hub_seq allocator exactly where it was', async () => {
      const { db, team } = await seed();
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1)]);

      // The allocator is bumped INSIDE the loop, one event at a time, so a throw on a later event
      // happens after earlier ones have already drawn numbers. Nothing leaks, because the bump and
      // the insert share the transaction the throw rolls back — asserted here rather than reasoned
      // about, since a leaked allocation is invisible until it shows as a hole in a dense order
      // (dolly, 2026-08-31, answering my open question by running it).
      await expect(
        ingestBatch(db, team.id, 'node-a', [await ev('node-a', 2), await ev('node-a', 4)]),
      ).rejects.toThrow(SyncGapError);
      expect(await db.get('SELECT next_hub_seq FROM sync_meta')).toEqual({ next_hub_seq: 2 });
      expect(await hubHead(db, team.id)).toBe(1);
      expect(await staged(db)).toEqual({ n: 1 });
      await db.close();
    });

    it('refuses an envelope naming a team other than the one it is pushed into', async () => {
      const { db, team } = await seed();
      const foreign = await ev('node-a', 1);
      foreign.envelope.team = 'dawn';

      // The hub authenticated the team, so the envelope does not get to name a different one. Nothing
      // in 3b-i reads envelope.team — but 3b-ii's fold is the reader, and a row whose team_id says
      // bravo while its payload says alpha is a contradiction the staging layer had the information
      // to refuse (dolly, 2026-08-28).
      await expect(ingestBatch(db, team.id, 'node-a', [foreign])).rejects.toThrow(SyncOriginError);
      expect(await staged(db)).toEqual({ n: 0 });
      await db.close();
    });

    it('reports no held sequence for a node that has pushed nothing', async () => {
      const { db, team } = await seed();
      expect(await highestContiguousSeq(db, 'node-b')).toBe(0);
      expect(await hubHead(db, team.id)).toBe(0);
      await db.close();
    });

    it('writes nothing to messages and moves no next_seq', async () => {
      const { db, team } = await seed();
      await ingestBatch(db, team.id, 'node-a', [await ev('node-a', 1), await ev('node-a', 2)]);
      expect(await db.get('SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 0 });
      expect(await db.all('SELECT next_seq FROM nodes')).toEqual([
        { next_seq: 1 },
        { next_seq: 1 },
      ]);
      await db.close();
    });
  });

  describe('lane genesis', () => {
    let seq = 0;
    async function append(
      db: ReturnType<typeof openDb>,
      teamId: string,
      payload: Record<string, unknown>,
    ) {
      seq += 1;
      const hub = ((await hubHead(db, teamId)) ?? 0) + 1;
      await db.run(
        'INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [`e${seq}`, teamId, 'node-a', seq, hub, JSON.stringify(payload), 0],
      );
    }
    const opened = (lane: string) => ({
      kind: 'lane',
      event: { action: 'lane.opened', target: lane, detail: { lane } },
    });

    it('tracks the smallest lane.opened id as the log grows, older births included', async () => {
      const { db, team } = await seed();
      expect(await laneGenesis(db, team.id)).toBeNull();
      await append(db, team.id, opened('01B'));
      expect(await laneGenesis(db, team.id)).toBe('01B');
      // Not a birth: neither a later message nor a later transition moves the watermark.
      await append(db, team.id, { kind: 'message', envelope: { id: 'm1' } });
      await append(db, team.id, {
        kind: 'lane',
        event: { action: 'lane.claimed', target: '01A', detail: { lane: '01A' } },
      });
      expect(await laneGenesis(db, team.id)).toBe('01B');
      // A birth for an OLDER lane appended later (clock skew across machines) lowers it.
      await append(db, team.id, opened('01A'));
      await append(db, team.id, opened('01C'));
      expect(await laneGenesis(db, team.id)).toBe('01A');
      await db.close();
    });

    it('keeps teams apart', async () => {
      const { db, team } = await seed();
      const other = await createTeam(db, { slug: 'dawn' });
      await append(db, team.id, opened('01Z'));
      expect(await laneGenesis(db, team.id)).toBe('01Z');
      expect(await laneGenesis(db, other.id)).toBeNull();
      await db.close();
    });
  });
});
