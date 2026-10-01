import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import {
  bindSeatToNode,
  listNodeLiveness,
  seatBinding,
  seatBindings,
  touchNode,
  trustNodeForSeat,
  unbindSeat,
  upsertForeignNode,
} from './nodes.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('nodes.residence', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * The seat→node residence binding ADR 328 §4 decided and ADR 355 recorded without enforcing
   * (gptbot's #1190 decline, 2026-09-02): the hub mints "seat X lives on node N" the first time N
   * speaks for X, first-writer-wins under a guarded CAS, and a later node is refused with the bound
   * node named. Re-binding is an explicit act (`unbindSeat`), never a silent overwrite.
   */

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    await db.run(
      "INSERT INTO nodes (id, team_id, label, next_seq) VALUES ('nA', ?, 'laptop-a', 1)",
      [team.id],
    );
    await db.run(
      "INSERT INTO nodes (id, team_id, label, next_seq) VALUES ('nB', ?, 'laptop-b', 1)",
      [team.id],
    );
    await db.run(
      "INSERT INTO nodes (id, team_id, label, next_seq, revoked_at) VALUES ('nX', ?, 'retired', 1, 5)",
      [team.id],
    );
    return { db, team, ada, nick };
  }

  describe('seat→node residence binding (ADR 328 §4)', async () => {
    it('the first node to speak for a seat binds it; the same node re-binds idempotently', async () => {
      const { db, team, ada } = await seed();
      expect(await bindSeatToNode(db, team.id, ada.id, 'nA', 10)).toEqual({ bound: true });
      expect(await bindSeatToNode(db, team.id, ada.id, 'nA', 11)).toEqual({ bound: true });
      expect(await seatBinding(db, ada.id)).toEqual({
        node_id: 'nA',
        label: 'laptop-a',
        bound_at: 10,
      });
    });

    it('a second node is refused with the bound node named — two nodes racing one seat, exactly one wins', async () => {
      const { db, team, ada } = await seed();
      expect(await bindSeatToNode(db, team.id, ada.id, 'nA', 10)).toEqual({ bound: true });
      expect(await bindSeatToNode(db, team.id, ada.id, 'nB', 11)).toEqual({
        bound: false,
        node_id: 'nA',
        label: 'laptop-a',
      });
      expect((await seatBinding(db, ada.id))?.node_id).toBe('nA');
    });

    it('unbind is the explicit re-bind act: after it, another node may bind', async () => {
      const { db, team, ada } = await seed();
      await bindSeatToNode(db, team.id, ada.id, 'nA', 10);
      expect(await unbindSeat(db, ada.id)).toEqual({ node_id: 'nA' });
      expect(await unbindSeat(db, ada.id)).toBeNull();
      expect(await bindSeatToNode(db, team.id, ada.id, 'nB', 12)).toEqual({ bound: true });
      expect((await seatBinding(db, ada.id))?.node_id).toBe('nB');
    });
  });

  describe('a human seat trusts a SET of machines (ADR 358)', async () => {
    it('a fresh machine cannot self-trust: the speaker must already be in the set, and an empty set has no voucher', async () => {
      const { db, team, nick } = await seed();
      expect(await trustNodeForSeat(db, team.id, nick, 'nB', 'nB', 10)).toEqual({
        trusted: false,
        reason: 'not_resident',
      });
      await bindSeatToNode(db, team.id, nick.id, 'nA', 10);
      expect(await trustNodeForSeat(db, team.id, nick, 'nB', 'nB', 11)).toEqual({
        trusted: false,
        reason: 'not_resident',
      });
      expect((await seatBindings(db, nick.id)).map((b) => b.node_id)).toEqual(['nA']);
    });

    it('from a bound node the act adds another; both then speak for the seat; a repeat is idempotent', async () => {
      const { db, team, nick } = await seed();
      await bindSeatToNode(db, team.id, nick.id, 'nA', 10);
      expect(await trustNodeForSeat(db, team.id, nick, 'nA', 'nB', 11)).toEqual({
        trusted: true,
        already: false,
      });
      expect((await seatBindings(db, nick.id)).map((b) => b.node_id)).toEqual(['nA', 'nB']);
      expect(await bindSeatToNode(db, team.id, nick.id, 'nB', 12)).toEqual({ bound: true });
      expect(await bindSeatToNode(db, team.id, nick.id, 'nA', 12)).toEqual({ bound: true });
      // The first-bound node stays the one a refusal names.
      expect((await seatBinding(db, nick.id))?.node_id).toBe('nA');
      expect(await trustNodeForSeat(db, team.id, nick, 'nB', 'nA', 13)).toEqual({
        trusted: true,
        already: true,
      });
    });

    it('agents stay one-node, and a target must be an enrolled unrevoked node', async () => {
      const { db, team, ada, nick } = await seed();
      await bindSeatToNode(db, team.id, ada.id, 'nA', 10);
      expect(await trustNodeForSeat(db, team.id, ada, 'nA', 'nB', 11)).toEqual({
        trusted: false,
        reason: 'not_human',
      });
      await bindSeatToNode(db, team.id, nick.id, 'nA', 10);
      expect(await trustNodeForSeat(db, team.id, nick, 'nA', 'nX', 11)).toEqual({
        trusted: false,
        reason: 'unknown_node',
      });
      expect(await trustNodeForSeat(db, team.id, nick, 'nA', 'nope', 11)).toEqual({
        trusted: false,
        reason: 'unknown_node',
      });
    });

    it('the admin unbind clears the whole set', async () => {
      const { db, team, nick } = await seed();
      await bindSeatToNode(db, team.id, nick.id, 'nA', 10);
      await trustNodeForSeat(db, team.id, nick, 'nA', 'nB', 11);
      expect(await unbindSeat(db, nick.id)).toEqual({ node_id: 'nA' });
      expect(await seatBindings(db, nick.id)).toEqual([]);
    });
  });

  describe('node liveness (presence replication, 2026-09-02)', async () => {
    it('touchNode stamps last_seen_at; upsertForeignNode never touches next_seq or credentials', async () => {
      const { db, team } = await seed();
      await upsertForeignNode(db, team.id, { id: 'nX', label: 'x', last_seen_at: 5 });
      await db.run('UPDATE nodes SET next_seq = 40, credential_hash = ? WHERE id = ?', ['h', 'nX']);
      await upsertForeignNode(db, team.id, { id: 'nX', label: 'x2', last_seen_at: 9 });
      await touchNode(db, 'nX', 11);
      expect(
        await db.get(
          'SELECT label, next_seq, credential_hash, last_seen_at FROM nodes WHERE id = ?',
          ['nX'],
        ),
      ).toEqual({ label: 'x2', next_seq: 40, credential_hash: 'h', last_seen_at: 11 });
      expect(await listNodeLiveness(db, team.id)).toContainEqual({
        id: 'nX',
        label: 'x2',
        last_seen_at: 11,
      });
    });
  });
});
