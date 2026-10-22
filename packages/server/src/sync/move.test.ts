import { GENERALIST_CAPABILITIES } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAuditByAction } from '../store/audit.js';
import { getProvision } from '../store/hostProvisions.js';
import { addMember, getMemberByName } from '../store/members.js';
import { bindSeatToNode, seatBindings } from '../store/nodes.js';
import {
  enrollResidency,
  getResidency,
  HOST_STALE_MS,
  recordHostSeen,
} from '../store/residency.js';
import type { MemberRow } from '../store/rows.js';
import { createTeam } from '../store/teams.js';
import { TrustRefusedError } from './claim.js';
import { applyMove } from './move.js';

let openStore: () => Promise<Driver>;

withDrivers('sync.move', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  /**
   * ADR 696: one act moves a seat between machines. Who may move what, the binding replaced in the
   * same transaction (no unbound window), and the wake enrollment handed to the destination.
   */
  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const add = async (name: string, kind: 'agent' | 'human', extra = {}) =>
      (await addMember(db, team, { name, kind, ...extra })).row;
    const nick = await add('nick', 'human');
    await db.run('UPDATE members SET capabilities = ? WHERE id = ?', [
      JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      nick.id,
    ]);
    const tj = await add('tj', 'human');
    const wallow = await add('wallow', 'agent');
    const ryder = await add('ryder', 'agent', { sponsoredBy: tj.id });
    for (const [id, label] of [
      ['nA', 'mac.lan'],
      ['nB', 'macbook-air-2.lan'],
    ])
      await db.run('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)', [
        id,
        team.id,
        label,
      ]);
    const fresh = async (name: string) => (await getMemberByName(db, team.id, name)) as MemberRow;
    return { db, team, nick: await fresh('nick'), tj, wallow, ryder };
  }
  const hub = { id: 'nA', label: 'mac.lan' };
  const air = { id: 'nB', label: 'macbook-air-2.lan' };

  it('an admin brings an agent here: the binding is replaced and the old machine is refused at once', async () => {
    const { db, team, nick, wallow } = await seed();
    await bindSeatToNode(db, team.id, wallow.id, 'nA', 10);
    const moved = await applyMove(db, team.id, {
      seat: wallow,
      actor: nick,
      speaker: air,
      to: 'macbook-air-2.lan',
      now: 20,
    });
    expect(moved).toEqual({
      seat: 'wallow',
      kind: 'agent',
      from: [{ node_id: 'nA', label: 'mac.lan' }],
      to: { node_id: 'nB', label: 'macbook-air-2.lan' },
      residency: null,
    });
    expect((await seatBindings(db, wallow.id)).map((b) => b.node_id)).toEqual(['nB']);
    expect(await bindSeatToNode(db, team.id, wallow.id, 'nA', 21)).toMatchObject({ bound: false });
    const [row] = await listAuditByAction(db, team.id, 'seat.moved');
    expect(row?.actor).toBe('nick');
    expect(JSON.parse(row!.detail!)).toMatchObject({ from: ['nA'], to: 'nB', by: 'nick' });
  });

  it("the agent's wake enrollment is revoked and handed back so the destination can re-enroll it", async () => {
    const { db, team, wallow } = await seed();
    await bindSeatToNode(db, team.id, wallow.id, 'nA', 10);
    await enrollResidency(db, team.id, {
      member_id: wallow.id,
      harness: 'claude-code',
      host: 'mac.lan',
      grant_id: null,
      authorized_by: 'nick',
      policy: { cooldown_ms: 900_000 },
    });
    // The seat moves itself (`musterd move wallow --to …` from its own session).
    const moved = await applyMove(db, team.id, {
      seat: wallow,
      actor: wallow,
      speaker: hub,
      to: 'nB',
    });
    expect(moved.residency).toEqual({
      harness: 'claude-code',
      host: 'mac.lan',
      policy: { cooldown_ms: 900_000 },
    });
    expect(await getResidency(db, team.id, wallow.id)).toBeNull();
    const [revoked] = await listAuditByAction(db, team.id, 'residency.revoked');
    expect(JSON.parse(revoked!.detail!)).toMatchObject({
      host: 'mac.lan',
      moved_to: 'macbook-air-2.lan',
    });
  });

  it("a sponsor moves the agents they sponsor, and no one else's", async () => {
    const { db, team, tj, ryder, wallow } = await seed();
    await expect(
      applyMove(db, team.id, { seat: ryder, actor: tj, speaker: air, to: 'nB' }),
    ).resolves.toMatchObject({ to: { node_id: 'nB' } });
    await expect(
      applyMove(db, team.id, { seat: wallow, actor: tj, speaker: air, to: 'nB' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      applyMove(db, team.id, { seat: wallow, actor: ryder, speaker: air, to: 'nB' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it("a person's seat gains a machine, only by that person, only from a machine already theirs", async () => {
    const { db, team, nick, tj } = await seed();
    await bindSeatToNode(db, team.id, tj.id, 'nA', 10);
    // An admin cannot move another person (ADR 358's rule is about the machine AND the person).
    await expect(
      applyMove(db, team.id, { seat: tj, actor: nick, speaker: hub, to: 'nB' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // tj from a machine not in the set: refused, the binding untouched.
    await expect(
      applyMove(db, team.id, { seat: tj, actor: tj, speaker: air, to: 'nB' }),
    ).rejects.toBeInstanceOf(TrustRefusedError);
    expect((await seatBindings(db, tj.id)).map((b) => b.node_id)).toEqual(['nA']);
    // From the machine tj already uses: the set gains the Air and keeps the hub.
    await applyMove(db, team.id, { seat: tj, actor: tj, speaker: hub, to: 'nB' });
    expect((await seatBindings(db, tj.id)).map((b) => b.node_id)).toEqual(['nA', 'nB']);
  });

  it('a mover who has left or only observes is refused, admin or not, and nothing moves', async () => {
    const { db, team, nick, wallow } = await seed();
    await bindSeatToNode(db, team.id, wallow.id, 'nA', 10);
    await expect(
      applyMove(db, team.id, {
        seat: wallow,
        actor: { ...nick, left_at: 5 },
        speaker: air,
        to: 'nB',
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      applyMove(db, team.id, {
        seat: wallow,
        actor: { ...nick, observer: 1 },
        speaker: air,
        to: 'nB',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await seatBindings(db, wallow.id)).map((b) => b.node_id)).toEqual(['nA']);
  });

  it('an unknown machine is refused with the ones that exist, and nothing changes', async () => {
    const { db, team, nick, wallow } = await seed();
    await bindSeatToNode(db, team.id, wallow.id, 'nA', 10);
    await expect(
      applyMove(db, team.id, { seat: wallow, actor: nick, speaker: hub, to: 'air3' }),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('known: mac.lan, macbook-air-2.lan'),
    });
    expect((await seatBindings(db, wallow.id)).map((b) => b.node_id)).toEqual(['nA']);
    expect(await listAuditByAction(db, team.id, 'seat.moved')).toEqual([]);
  });

  it('a live host on the target is handed the move, with the revoked harness', async () => {
    const { db, team, wallow } = await seed();
    await bindSeatToNode(db, team.id, wallow.id, 'nA', 10);
    await enrollResidency(db, team.id, {
      member_id: wallow.id,
      harness: 'muse',
      host: 'mac.lan',
      grant_id: null,
      authorized_by: 'nick',
      policy: { cooldown_ms: 900_000 },
    });
    const now = 1_000_000;
    await db.run('INSERT INTO host_liveness (team_id, host, seen_at, node) VALUES (?, ?, ?, ?)', [
      team.id,
      'air-host',
      now,
      'nB',
    ]);
    const moved = await applyMove(db, team.id, {
      seat: wallow,
      actor: wallow,
      speaker: hub,
      to: 'nB',
      now,
      handToHost: true,
      homeNodeId: 'nA',
    });
    expect(moved.provision?.host).toBe('air-host');
    const row = await getProvision(db, team.id, moved.provision!.id);
    expect(row?.kind).toBe('move');
    expect(row?.host).toBe('air-host');
    expect(JSON.parse(row!.move_json!)).toEqual({
      harness: 'muse',
      policy: { cooldown_ms: 900_000 },
    });
    const [pending] = await listAuditByAction(db, team.id, 'host.provision_pending');
    expect(JSON.parse(pending!.detail!)).toMatchObject({
      agent: 'wallow',
      sponsor: 'wallow',
      host: 'air-host',
      kind: 'move',
    });
  });

  it('no live host, a stale one, or a poll that never named a node, queues nothing', async () => {
    const { db, team, wallow } = await seed();
    await bindSeatToNode(db, team.id, wallow.id, 'nA', 10);
    const now = 1_000_000;
    await db.run('INSERT INTO host_liveness (team_id, host, seen_at, node) VALUES (?, ?, ?, ?)', [
      team.id,
      'stale',
      now - HOST_STALE_MS - 1,
      'nB',
    ]);
    await db.run('INSERT INTO host_liveness (team_id, host, seen_at, node) VALUES (?, ?, ?, ?)', [
      team.id,
      'bound-only',
      0,
      'nB',
    ]);
    // A host that only polled here, with no node binding, is not on the other machine.
    await recordHostSeen(db, team.id, 'local-only', now, null);
    const missed = await applyMove(db, team.id, {
      seat: wallow,
      actor: wallow,
      speaker: hub,
      to: 'nB',
      now,
      handToHost: true,
      homeNodeId: 'nA',
    });
    expect(missed.provision).toBeUndefined();
    expect(await listAuditByAction(db, team.id, 'host.provision_pending')).toEqual([]);
  });

  it('a host with no node binding counts only when the target is this daemon', async () => {
    const { db, team, wallow } = await seed();
    await bindSeatToNode(db, team.id, wallow.id, 'nA', 10);
    const now = 1_000_000;
    await recordHostSeen(db, team.id, 'here-host', now, null);
    const moved = await applyMove(db, team.id, {
      seat: wallow,
      actor: wallow,
      speaker: hub,
      to: 'nA',
      now,
      handToHost: true,
      homeNodeId: 'nA',
    });
    expect(moved.provision).toMatchObject({ host: 'here-host' });
    const row = await getProvision(db, team.id, moved.provision!.id);
    expect(JSON.parse(row!.move_json!)).toEqual({ harness: 'claude-code', policy: null });
  });

  it('omitting the hand, or moving a person, writes no provision even when a host is live', async () => {
    const { db, team, nick, wallow } = await seed();
    await bindSeatToNode(db, team.id, wallow.id, 'nA', 10);
    await bindSeatToNode(db, team.id, nick.id, 'nA', 10);
    const now = 1_000_000;
    await db.run('INSERT INTO host_liveness (team_id, host, seen_at, node) VALUES (?, ?, ?, ?)', [
      team.id,
      'air-host',
      now,
      'nB',
    ]);
    const quiet = await applyMove(db, team.id, {
      seat: wallow,
      actor: wallow,
      speaker: hub,
      to: 'nB',
      now,
    });
    expect(quiet.provision).toBeUndefined();
    const person = await applyMove(db, team.id, {
      seat: nick,
      actor: nick,
      speaker: hub,
      to: 'nB',
      now,
      handToHost: true,
      homeNodeId: 'nA',
    });
    expect(person.provision).toBeUndefined();
    expect(person.kind).toBe('human');
  });
});
