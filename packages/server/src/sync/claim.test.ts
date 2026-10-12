import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { getLane, updateLane } from '../store/lanes.js';
import { addMember, getMemberByName, mintCredential } from '../store/members.js';
import { insertMessage, localNodeForTeam } from '../store/messages.js';
import { unbindSeat } from '../store/nodes.js';
import { touchAmbientPresence } from '../store/presence.js';
import { claimWakeLeases, enrollResidency } from '../store/residency.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('claim', (_o, kind) => {
  /**
   * Federation increment 3c (ADR 325 §Authority split, residence 1): a lane claim is hub-authoritative.
   * On a joiner a self-claim goes to the hub, which runs the CAS and answers with the lane or a
   * DISTINGUISHABLE conflict naming the holder; while the hub is unreachable the claim refuses with
   * its own error rather than landing provisionally.
   *
   * The lane's falsifier, verbatim: "a claim minted on a joiner reaches the hub and a competing claim
   * for the same lane is refused with a distinguishable error, not silently dropped."
   *
   * Harness copied from lanes.test.ts so this file stands alone.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickOnHub: string;
  let nickOnJoiner: string;
  /** A hub-resident seat that opens the shared lanes, so nick's residence stays the tests' to decide. */
  let hanaOnHub: string;
  let dir: string;
  let joinerCtx: Ctx;

  async function call(base: string, method: string, path: string, body?: unknown, auth?: string) {
    const response = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
  }
  const post = async (base: string, path: string, body?: unknown, auth?: string) =>
    await call(base, 'POST', path, body, auth);
  const patch = async (base: string, path: string, body?: unknown, auth?: string) =>
    await call(base, 'PATCH', path, body, auth);

  async function enrollJoiner() {
    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'joiner laptop' },
      nickOnHub,
    );
    const res = await post(joinerBase, '/node/enroll', {
      hub_url: hubBase,
      code: minted.invite,
      team: 'bravo',
    });
    expect(res.status).toBe(200);
  }

  const hubCtx = (): Ctx => ({
    db: hub.store,
    hub: new Hub(),
    config: resolveConfig(),
    rosterRoots: [],
  });
  const hubTeam = async () => (await getTeamBySlug(hub.store, 'bravo'))!;
  const joinerTeam = async () => (await getTeamBySlug(joiner.store, 'bravo'))!;

  /** Hub → joiner: the hub stages its own history (loopback), the joiner folds it. */
  async function hubToJoiner() {
    await pushTeam(hubCtx(), await hubTeam());
    await pullTeam(joinerCtx, await joinerTeam());
  }

  /** A lane born on the hub, unowned, visible on both machines. */
  async function laneOnBoth(title = 'shared'): Promise<string> {
    // Opened by hana, not nick: since push-level residence (2026-09-02) every kind binds at ingest,
    // so a lane nick opened here would bind nick to the hub at the loopback push and the joiner's
    // claim as nick would be `bound_elsewhere` — the rule working, against a premise these cases
    // set differently (nick lives on the joiner).
    const opened = await post(hubBase, '/teams/bravo/lanes', { title }, hanaOnHub);
    expect(opened.status).toBe(201);
    const id: string = opened.json.lane.id;
    await hubToJoiner();
    expect(await getLane(joiner.store, (await joinerTeam()).id, id, 'bravo')).toMatchObject({
      id,
      owner_seat: null,
    });
    return id;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-claim-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

    hub = createServer({ db: await openTestDriver(kind), port: 0, syncLoops: false });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({
      db: await openTestDriver(kind, { instance: 'b' }),
      port: 0,
      syncLoops: false,
    });
    joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
    joinerCtx = {
      db: joiner.store,
      hub: new Hub(),
      config: resolveConfig(),
      rosterRoots: [],
    };

    const onHub = await post(hubBase, '/teams', {
      slug: 'bravo',
      creator: { name: 'nick', kind: 'human' },
    });
    nickOnHub = onHub.json.human_credential;
    const onJoiner = await post(joinerBase, '/teams', {
      slug: 'bravo',
      creator: { name: 'nick', kind: 'human' },
    });
    nickOnJoiner = onJoiner.json.human_credential;
    // Roster identity replicates via git (ADR 058): the same second seat exists on both.
    await addMember(hub.store, await hubTeam(), { name: 'ada', kind: 'agent' });
    await addMember(joiner.store, await joinerTeam(), { name: 'ada', kind: 'agent' });
    hanaOnHub = (
      await mintCredential(
        hub.store,
        (await addMember(hub.store, await hubTeam(), { name: 'hana', kind: 'human' })).row.id,
      )
    ).credential;
    await addMember(joiner.store, await joinerTeam(), { name: 'hana', kind: 'human' });
    // The joiner's node row is minted on its first logged act; enrollment needs it to exist.
    const jt = await joinerTeam();
    const nick = await joiner.store.get('SELECT id FROM members WHERE team_id = ? LIMIT 1', [
      jt.id,
    ])!;
    await insertMessage(
      joiner.store,
      jt.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'j-0',
        team: 'bravo',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: 'hi',
        ts: 1000,
      }),
    );
    await enrollJoiner();
    // nick's first authenticated touch on the hub attaches an ambient presence there, and the hub's
    // own staging binds nick to the hub's node the moment that `presence.attached` is ingested
    // (presence replication §2). These cases are about the CLAIM edge with nick living on the
    // joiner, so take that first touch now, stage it, and release the fixture's binding — the same
    // admin unbind a human on two machines uses. Later touches refresh the row and emit nothing, so
    // nothing re-binds behind the tests' backs.
    const nickOnHubRow = (await getMemberByName(hub.store, (await hubTeam()).id, 'nick'))!;
    await touchAmbientPresence(hub.store, nickOnHubRow.id, 'cli', 45_000);
    await pushTeam(hubCtx(), await hubTeam());
    await unbindSeat(hub.store, nickOnHubRow.id);
  });

  afterEach(async () => {
    await hub.close().catch(() => undefined);
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe('federation 3c — the hub arbitrates a claim', () => {
    it('a claim on the joiner is decided by the hub, whose row names the node the seat resides on', async () => {
      const laneId = await laneOnBoth();
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(res.status).toBe(200);
      expect(res.json.lane).toMatchObject({ id: laneId, owner_seat: 'nick', state: 'claimed' });

      // The hub holds the decision.
      expect(await getLane(hub.store, (await hubTeam()).id, laneId, 'bravo')).toMatchObject({
        owner_seat: 'nick',
        state: 'claimed',
      });
      // Seat→node residence binding, in the log: the hub's claimed row names the joiner's node.
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      const claimed = await hub.store.get(
        "SELECT actor, detail FROM audit WHERE action = 'lane.claimed' AND target = ?",
        [laneId],
      )!;
      expect(claimed.actor).toBe('nick');
      expect(JSON.parse(claimed.detail)).toMatchObject({ owner: 'nick', node: joinerNode });
      // The joiner converges from the hub's log, not from a local write of its own.
      expect(
        await joiner.store.get(
          "SELECT COUNT(*) AS n FROM audit WHERE action = 'lane.claimed' AND target = ?",
          [laneId],
        ),
      ).toEqual({ n: 1 });
      await hubToJoiner();
      expect(await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo')).toMatchObject({
        owner_seat: 'nick',
        state: 'claimed',
      });
    });

    // Lane 01M41QG1HY (sloane on Air 2, 2026-10-03): the hub applied blocked→active for a joiner
    // seat, yet the joiner's row stayed `blocked`, and every later arbitrated write from the joiner
    // was refused by the hub's CAS against the stale `expect`. The falsifier: a run of state moves
    // decided by the hub for a joiner seat converges on the joiner, and the next write is accepted.
    it("a joiner seat's state moves decided by the hub fold back to the joiner, so its next write is not refused", async () => {
      const laneId = await laneOnBoth();
      const jt = await joinerTeam();
      const move = async (state: string) => {
        const res = await patch(
          joinerBase,
          `/teams/bravo/lanes/${laneId}`,
          { state },
          nickOnJoiner,
        );
        expect(res.status, JSON.stringify(res.json)).toBe(200);
        await hubToJoiner();
        expect((await getLane(joiner.store, jt.id, laneId, 'bravo'))!.state).toBe(state);
      };
      const claim = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(claim.status).toBe(200);
      await hubToJoiner();
      await move('active');
      await move('blocked');
      await move('active');
      // The write sloane could not make: an edit that moves state, with the joiner's own row as `expect`.
      const submit = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { state: 'awaiting_acceptance' },
        nickOnJoiner,
      );
      expect(submit.status, JSON.stringify(submit.json)).toBe(200);
    });

    it("a competing claim is refused with a distinguishable error naming the holder, and the joiner's row is untouched", async () => {
      const laneId = await laneOnBoth();
      // ada takes it on the hub first; the joiner has not yet seen that.
      await updateLane(
        hub.store,
        (await hubTeam()).id,
        laneId,
        'bravo',
        { owner_seat: 'ada' },
        5,
        undefined,
        {
          actor: 'ada',
        },
      );
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('conflict');
      expect(res.json.error.message).toContain('ada');
      expect(res.json.holder).toBe('ada');
      expect((await getLane(hub.store, (await hubTeam()).id, laneId, 'bravo'))!.owner_seat).toBe(
        'ada',
      );
      // The refused claim must leave no provisional claim by nick on the joiner. The row may already
      // read 'ada' — the hub's own `lane.claimed` folds in on a doorbell/kick (which fires on every
      // driver since the kick registries stopped keying on a db handle) — so assert what the refusal
      // guarantees, not the instant at which the fold lands.
      const joinerOwner = (await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo'))!
        .owner_seat;
      expect(joinerOwner === null || joinerOwner === 'ada').toBe(true);
    });

    it('refuses, with its own error, while the hub is unreachable — never a provisional claim', async () => {
      const laneId = await laneOnBoth();
      await hub.close();
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('hub_unreachable');
      expect(
        (await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo'))!.owner_seat,
      ).toBeNull();
    });

    it("a handoff while the hub is unreachable refuses hub_unreachable — every ownership edge is the hub's (ADR 361); a title edit stays local", async () => {
      const laneId = await laneOnBoth();
      await hub.close();
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'ada' },
        nickOnJoiner,
      );
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('hub_unreachable');
      expect(
        (await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo'))!.owner_seat,
      ).toBeNull();
      // Residence 2 stays available while partitioned: an edit that moves neither owner nor state.
      const edit = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { title: 'renamed offline' },
        nickOnJoiner,
      );
      expect(edit.status).toBe(200);
      expect((await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo'))!.title).toBe(
        'renamed offline',
      );
    });

    it('a claim binds the seat to the claiming node; a claim for a seat bound elsewhere is refused 403 naming that node (ADR 328 §4)', async () => {
      const laneA = await laneOnBoth('a');
      const laneB = await laneOnBoth('b');
      // nick claims locally on the hub first: nick now lives on the hub's node.
      const onHub = await patch(
        hubBase,
        `/teams/bravo/lanes/${laneA}`,
        { owner_seat: 'nick' },
        nickOnHub,
      );
      expect(onHub.status).toBe(200);
      // The joiner, an admitted node, asks to claim AS nick. Before this fix the hub said yes.
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneB}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('bound_elsewhere');
      expect(res.json.node_label).toBe(hostname());
      expect(
        (await getLane(hub.store, (await hubTeam()).id, laneB, 'bravo'))!.owner_seat,
      ).toBeNull();
      // The binding is a hub fact, and the ledger says so.
      expect(
        await hub.store.get(
          "SELECT COUNT(*) AS n FROM audit WHERE action = 'seat.bound_elsewhere'",
        ),
      ).toEqual({ n: 1 });
    });

    it('unbinding (the explicit re-bind act, admin-only) lets the seat move: the next claim binds it to the joiner', async () => {
      const laneA = await laneOnBoth('a');
      const laneB = await laneOnBoth('b');
      await patch(hubBase, `/teams/bravo/lanes/${laneA}`, { owner_seat: 'nick' }, nickOnHub);
      // The hub's push loop stages that claim in the background (kicked by the write) and binds nick
      // to the hub at ingest. Unbind only after it has: an ingest that lands after the unbind
      // re-binds nick, and the joiner's claim below is then refused as the rule working.
      const nickId = (
        (await hub.store.get("SELECT id FROM members WHERE team_id = ? AND name = 'nick'", [
          (await hubTeam()).id,
        ])) as { id: string }
      ).id;
      for (let i = 0; i < 200; i++) {
        if (await hub.store.get('SELECT node_id FROM seat_nodes WHERE member_id = ?', [nickId]))
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const unbound = await call(
        hubBase,
        'DELETE',
        '/teams/bravo/nodes/bindings/nick',
        undefined,
        nickOnHub,
      );
      expect(unbound.status).toBe(200);
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneB}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(res.status).toBe(200);
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      const nick = await hub.store.get(
        "SELECT id FROM members WHERE team_id = ? AND name = 'nick'",
        [(await hubTeam()).id],
      )!;
      expect(
        await hub.store.get('SELECT node_id FROM seat_nodes WHERE member_id = ?', [nick.id]),
      ).toEqual({ node_id: joinerNode });
      // Now the hub's own local claim as nick is the one refused.
      const laneC = await laneOnBoth('c');
      const local = await patch(
        hubBase,
        `/teams/bravo/lanes/${laneC}`,
        { owner_seat: 'nick' },
        nickOnHub,
      );
      expect(local.status).toBe(403);
      expect(local.json.error.code).toBe('bound_elsewhere');
    });

    it('the hub refuses a claim from a node for a lane it has not yet folded, so the joiner retries after sync', async () => {
      const opened = await post(
        joinerBase,
        '/teams/bravo/lanes',
        { title: 'unsynced' },
        nickOnJoiner,
      );
      const laneId: string = opened.json.lane.id;
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(res.status).toBe(409);
      expect(res.json.error.message).toMatch(/not yet replicated|sync/);
    });
  });

  describe('ADR 358 — a human seat trusts a set of machines by an explicit act from a bound session', async () => {
    const bindingsOf = async (name: string) =>
      (
        await hub.store.all(
          `SELECT s.node_id FROM seat_nodes s JOIN members m ON m.id = s.member_id
          WHERE m.team_id = ? AND m.name = ? ORDER BY s.bound_at, s.node_id`,
          [(await hubTeam()).id, name],
        )
      ).map((r) => r.node_id);

    it('a fresh machine cannot self-trust: the joiner asking for itself is refused with the bound node named, and nothing changes', async () => {
      const laneA = await laneOnBoth('a');
      await patch(hubBase, `/teams/bravo/lanes/${laneA}`, { owner_seat: 'nick' }, nickOnHub);
      const hubNode = (await localNodeForTeam(hub.store, (await hubTeam()).id)).id;
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      expect(await bindingsOf('nick')).toEqual([hubNode]);

      const res = await post(
        joinerBase,
        '/teams/bravo/nodes/trust',
        { node_id: joinerNode },
        nickOnJoiner,
      );
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('bound_elsewhere');
      expect(res.json.node_id).toBe(hubNode);
      expect(await bindingsOf('nick')).toEqual([hubNode]);
      const denied = await hub.store.get(
        "SELECT detail FROM audit WHERE action = 'seat.bound_elsewhere' AND result = 'deny' ORDER BY id DESC LIMIT 1",
      )!;
      expect(JSON.parse(denied.detail)).toMatchObject({
        act: 'trust',
        node: joinerNode,
        bound_to: hubNode,
      });
    });

    it('from the bound machine the seat trusts the joiner; both then claim as it, and the act forwarded from the joiner is idempotent', async () => {
      const laneA = await laneOnBoth('a');
      await patch(hubBase, `/teams/bravo/lanes/${laneA}`, { owner_seat: 'nick' }, nickOnHub);
      const hubNode = (await localNodeForTeam(hub.store, (await hubTeam()).id)).id;
      const joinerNode = readNodeState().nodes['bravo']!.node_id;

      const trusted = await post(
        hubBase,
        '/teams/bravo/nodes/trust',
        { node_id: joinerNode },
        nickOnHub,
      );
      expect(trusted.status).toBe(200);
      expect(trusted.json).toEqual({ seat: 'nick', node_id: joinerNode, already: false });
      expect(await bindingsOf('nick')).toEqual([hubNode, joinerNode]);
      expect(
        await hub.store.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'seat.node_trusted'"),
      ).toEqual({ n: 1 });

      // The joiner now speaks for nick — and so does the hub still.
      const laneB = await laneOnBoth('b');
      const fromJoiner = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneB}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(fromJoiner.status).toBe(200);
      const laneC = await laneOnBoth('c');
      const fromHub = await patch(
        hubBase,
        `/teams/bravo/lanes/${laneC}`,
        { owner_seat: 'nick' },
        nickOnHub,
      );
      expect(fromHub.status).toBe(200);

      // Forwarded: a session on the joiner (now in the set) vouches for the hub's node — already there.
      const again = await post(
        joinerBase,
        '/teams/bravo/nodes/trust',
        { node_id: hubNode },
        nickOnJoiner,
      );
      expect(again.status).toBe(200);
      expect(again.json).toEqual({ seat: 'nick', node_id: hubNode, already: true });
      expect(await bindingsOf('nick')).toEqual([hubNode, joinerNode]);
    });

    it('a node the hub does not know is refused 404, and the admin unbind clears the whole set', async () => {
      const laneA = await laneOnBoth('a');
      await patch(hubBase, `/teams/bravo/lanes/${laneA}`, { owner_seat: 'nick' }, nickOnHub);
      const unknown = await post(
        hubBase,
        '/teams/bravo/nodes/trust',
        { node_id: 'nope' },
        nickOnHub,
      );
      expect(unknown.status).toBe(404);
      expect(unknown.json.error.code).toBe('not_found');
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      await post(hubBase, '/teams/bravo/nodes/trust', { node_id: joinerNode }, nickOnHub);
      expect(await bindingsOf('nick')).toHaveLength(2);
      const unbound = await call(
        hubBase,
        'DELETE',
        '/teams/bravo/nodes/bindings/nick',
        undefined,
        nickOnHub,
      );
      expect(unbound.status).toBe(200);
      expect(await bindingsOf('nick')).toEqual([]);
    });
  });

  describe('ADR 361 — release, handoff and close on a joiner are decided by the hub, and the origin speaks', () => {
    const joinerNode = () => readNodeState().nodes['bravo']!.node_id;
    const laneAudit = async (db: Driver, laneId: string, action: string) =>
      await db.all('SELECT actor, origin_node, detail FROM audit WHERE action = ? AND target = ?', [
        action,
        laneId,
      ]);
    const actsOn = async (db: Driver, teamId: string, metaKey: string, laneId: string) =>
      (await db.get(`SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND meta LIKE ?`, [
        teamId,
        `%"${metaKey}":{"lane":"${laneId}"%`,
      ]))!.n;
    async function claimedOnJoiner(title: string): Promise<string> {
      const laneId = await laneOnBoth(title);
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(res.status).toBe(200);
      await hubToJoiner();
      return laneId;
    }

    it('a release on the joiner is decided by the hub: the hub writes the row, the joiner writes nothing and speaks the act', async () => {
      const laneId = await claimedOnJoiner('r');
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { state: 'open' },
        nickOnJoiner,
      );
      expect(res.status).toBe(200);
      expect(res.json.lane).toMatchObject({ id: laneId, owner_seat: null, state: 'open' });
      expect(await getLane(hub.store, (await hubTeam()).id, laneId, 'bravo')).toMatchObject({
        owner_seat: null,
        state: 'open',
      });
      const released = await laneAudit(hub.store, laneId, 'lane.released');
      expect(released).toHaveLength(1);
      expect(JSON.parse(released[0]!.detail)).toMatchObject({ node: joinerNode() });
      expect(
        (await laneAudit(joiner.store, laneId, 'lane.released')).filter(
          (r) => r.origin_node === joinerNode(),
        ),
      ).toHaveLength(0);
      // The origin speaks: one `[lane] released` act, minted on the joiner as nick.
      expect(await actsOn(joiner.store, (await joinerTeam()).id, 'lane_release', laneId)).toBe(1);
      await hubToJoiner();
      expect(await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo')).toMatchObject({
        owner_seat: null,
        state: 'open',
      });
    });

    it('a handoff on a stale joiner row is refused by the hub naming the real holder; the joiner row is untouched', async () => {
      const laneId = await claimedOnJoiner('h');
      // The hub's row moves under the joiner: ada takes it there, the joiner has not pulled.
      await updateLane(
        hub.store,
        (await hubTeam()).id,
        laneId,
        'bravo',
        { owner_seat: 'ada' },
        7,
        undefined,
        {
          actor: 'ada',
        },
      );
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'hana' },
        nickOnJoiner,
      );
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('conflict');
      expect(res.json.holder).toBe('ada');
      expect(
        (await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo'))!.owner_seat,
      ).toBe('nick');
      expect(await actsOn(joiner.store, (await joinerTeam()).id, 'lane_handoff', laneId)).toBe(0);
    });

    it("a handoff on the joiner lands on the hub with the joiner named, and the recipient's handoff act is minted once, on the joiner", async () => {
      const laneId = await claimedOnJoiner('g');
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'ada', handoff_note: 'yours now' },
        nickOnJoiner,
      );
      expect(res.status).toBe(200);
      expect(res.json.lane).toMatchObject({ owner_seat: 'ada' });
      expect((await getLane(hub.store, (await hubTeam()).id, laneId, 'bravo'))!.owner_seat).toBe(
        'ada',
      );
      const handoffs = (await joiner.store.get(
        "SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND act = 'handoff' AND body LIKE '%yours now%'",
        [(await joinerTeam()).id],
      ))!.n;
      expect(handoffs).toBe(1);
      expect(
        (await hub.store.get(
          "SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND act = 'handoff' AND body LIKE '%yours now%'",
          [(await hubTeam()).id],
        ))!.n,
      ).toBe(0); // the hub emitted nothing of its own
    });

    it("a close on the joiner is decided by the hub: the answer says done, the hub's log carries lane.closed naming the joiner, and every read on the joiner agrees after the fold (delta, 01M2GBGA03)", async () => {
      const laneId = await claimedOnJoiner('d');
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { state: 'done', merged: { pr: 1, sha: 'abc', authorized_by: 'nick' } },
        nickOnJoiner,
      );
      expect(res.status).toBe(200);
      // (1) the resolve's own echo is the decision, not the stale local row.
      expect(res.json.lane).toMatchObject({ id: laneId, owner_seat: 'nick', state: 'done' });
      expect(res.json.lane.resolved_at).not.toBeNull();
      expect(res.json.closed).toMatchObject({ verified: false, reason: 'self_close' });
      expect(await getLane(hub.store, (await hubTeam()).id, laneId, 'bravo')).toMatchObject({
        state: 'done',
      });
      // The terminal transition is recorded once, on the hub, as the seat, naming the joiner —
      // the same shape a release takes. Without it nothing ever folds the close back.
      const closed = await laneAudit(hub.store, laneId, 'lane.closed');
      expect(closed).toHaveLength(1);
      expect(closed[0]!.actor).toBe('nick');
      expect(JSON.parse(closed[0]!.detail)).toMatchObject({
        node: joinerNode(),
        state: 'done',
        closed_by: 'nick',
        verified: false,
        reason: 'self_close',
      });
      expect(
        (await laneAudit(joiner.store, laneId, 'lane.closed')).filter(
          (r) => r.origin_node === joinerNode(),
        ),
      ).toHaveLength(0);
      // The origin speaks: one `[lane] resolved` act, minted on the joiner as nick.
      expect(await actsOn(joiner.store, (await joinerTeam()).id, 'lane_resolve', laneId)).toBe(1);
      // (2)/(3): the board and the wake context read this row — after the fold it says done.
      await hubToJoiner();
      expect(await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo')).toMatchObject({
        owner_seat: 'nick',
        state: 'done',
      });
      expect(
        (await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo'))!.resolved_at,
      ).not.toBeNull();
    });

    it("a submit on the joiner is decided by the hub: the answer says awaiting_acceptance, the hub's log carries a foldable state move naming the joiner, and every read on the joiner agrees after the fold", async () => {
      const laneId = await claimedOnJoiner('s');
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { state: 'ready_for_review', merged: { pr: 1, sha: 'abc', authorized_by: 'nick' } },
        nickOnJoiner,
      );
      expect(res.status).toBe(200);
      // The submit's own echo is the decision, not the stale local row — same echo fault the close
      // had until lane 01M2GPX0HP.
      expect(res.json.lane).toMatchObject({
        id: laneId,
        owner_seat: 'nick',
        state: 'awaiting_acceptance',
        merged: { pr: 1, sha: 'abc', authorized_by: 'nick' },
      });
      expect(await getLane(hub.store, (await hubTeam()).id, laneId, 'bravo')).toMatchObject({
        owner_seat: 'nick',
        state: 'awaiting_acceptance',
        merged: { pr: 1, sha: 'abc', authorized_by: 'nick' },
      });
      // updateLane skips lane.state_changed for awaiting_acceptance — that verb is
      // lane.ready_for_review, owned by the origin PATCH handler (routing + ask stay where the
      // seat lives). On the hub that skip left NOTHING foldable, so the joiner's row stayed
      // claimed and a retry CAS'd against awaiting_acceptance. The hub records the state move
      // as lane.state_changed (with node) so the fold can apply it; ready_for_review stays the
      // origin's, once.
      const changed = await laneAudit(hub.store, laneId, 'lane.state_changed');
      expect(changed).toHaveLength(1);
      expect(changed[0]!.actor).toBe('nick');
      expect(JSON.parse(changed[0]!.detail)).toMatchObject({
        node: joinerNode(),
        from: 'claimed',
        to: 'awaiting_acceptance',
      });
      expect(
        (await laneAudit(joiner.store, laneId, 'lane.state_changed')).filter(
          (r) => r.origin_node === joinerNode(),
        ),
      ).toHaveLength(0);
      await hubToJoiner();
      expect(await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo')).toMatchObject({
        owner_seat: 'nick',
        state: 'awaiting_acceptance',
        merged: { pr: 1, sha: 'abc', authorized_by: 'nick' },
      });
      // The prescribed retry is not a permanent wedge: the joiner's expectation now matches the hub.
      const retry = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { state: 'ready_for_review', merged: { pr: 1, sha: 'abc', authorized_by: 'nick' } },
        nickOnJoiner,
      );
      expect(retry.status).not.toBe(409);
    });

    it("a submit the hub refuses as a bad request reaches the joiner's caller as that refusal, not a 500 (lane 01M4S1GJJ6)", async () => {
      // dreamy, 2026-10-12: five submits from a joiner came back as a bare "internal server error"
      // while the hub had answered 400 with the repair (ADR 487: pass follows_up).
      const laneId = await claimedOnJoiner('spend controls, part 1 of 3');
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { state: 'ready_for_review', merged: { pr: 1, sha: 'abc', authorized_by: 'nick' } },
        nickOnJoiner,
      );
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('bad_request');
      expect(res.json.error.message).toContain('pass follows_up');
      expect((await getLane(hub.store, (await hubTeam()).id, laneId, 'bravo'))!.state).toBe(
        'claimed',
      );
    });

    it('a terminal close while the hub is unreachable refuses hub_unreachable and moves nothing', async () => {
      const laneId = await claimedOnJoiner('c');
      await hub.close();
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { state: 'done', merged: { pr: 1, sha: 'abc', authorized_by: 'nick' } },
        nickOnJoiner,
      );
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('hub_unreachable');
      expect(await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo')).toMatchObject({
        owner_seat: 'nick',
        state: 'claimed',
      });
    });

    it("an arbitrated claim produces exactly one `[lane] claimed` act on every machine — the origin's", async () => {
      const laneId = await laneOnBoth('one');
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(res.status).toBe(200);
      expect(await actsOn(joiner.store, (await joinerTeam()).id, 'lane_claim', laneId)).toBe(1);
      await pushTeam(joinerCtx, await joinerTeam());
      await pullTeam(hubCtx(), await hubTeam()); // the hub folds its own staged log on its pull tick
      await hubToJoiner();
      expect(await actsOn(hub.store, (await hubTeam()).id, 'lane_claim', laneId)).toBe(1);
      expect(await actsOn(joiner.store, (await joinerTeam()).id, 'lane_claim', laneId)).toBe(1);
    });
  });

  describe('a directed act folded from another machine wakes the recipient where they live (residence 3 stays local)', async () => {
    const HOST = 'joiner-laptop.local';
    const enrollOn = async (server: RunningServer, name: string) => {
      const team = (await getTeamBySlug(server.store, 'bravo'))!;
      const member = (await getMemberByName(server.store, team.id, name))!;
      await enrollResidency(server.store, team.id, {
        member_id: member.id,
        harness: 'claude-code',
        host: HOST,
        grant_id: 'g1',
        authorized_by: 'nick',
      });
    };

    it("a handoff minted on the hub for a seat resident on the joiner folds there and the joiner's host poll leases a wake for it; the hub, where the seat is not resident, leases nothing", async () => {
      await enrollOn(joiner, 'ada'); // ada lives on the joiner and is offline there
      const laneId = await laneOnBoth('w');
      // nick, resident on the hub, claims and hands the lane to ada — the act is minted on the hub.
      const claimed = await patch(
        hubBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnHub,
      );
      expect(claimed.status).toBe(200);
      const handed = await patch(
        hubBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'ada', handoff_note: 'yours, from the other machine' },
        nickOnHub,
      );
      expect(handed.status).toBe(200);
      const handoffId = (await hub.store.get(
        "SELECT id FROM messages WHERE team_id = ? AND act = 'handoff' ORDER BY ts DESC LIMIT 1",
        [(await hubTeam()).id],
      ))!.id;

      // The hub cannot wake ada: no residency row here.
      expect(await claimWakeLeases(hub.store, (await hubTeam()).id, 'bravo', HOST, 45_000)).toEqual(
        [],
      );

      await hubToJoiner();
      expect(
        await joiner.store.get('SELECT COUNT(*) AS n FROM messages WHERE id = ?', [handoffId]),
      ).toEqual({ n: 1 });
      const orders = await claimWakeLeases(
        joiner.store,
        (await joinerTeam()).id,
        'bravo',
        HOST,
        45_000,
      );
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ seat: 'ada', act_id: handoffId, sender: 'nick' });
      expect(
        await joiner.store.get(
          "SELECT COUNT(*) AS n FROM audit WHERE action = 'residency.wake_leased' AND target = ?",
          ['ada'],
        ),
      ).toEqual({ n: 1 });
    });

    it('a folded reply discharges the sender-side ledger: after ada accepts on the joiner and it folds back, the hub no longer lists the handoff as open', async () => {
      await enrollOn(joiner, 'ada');
      const laneId = await laneOnBoth('d');
      await patch(hubBase, `/teams/bravo/lanes/${laneId}`, { owner_seat: 'nick' }, nickOnHub);
      await patch(hubBase, `/teams/bravo/lanes/${laneId}`, { owner_seat: 'ada' }, nickOnHub);
      const handoffId = (await hub.store.get(
        "SELECT id FROM messages WHERE team_id = ? AND act = 'handoff' ORDER BY ts DESC LIMIT 1",
        [(await hubTeam()).id],
      ))!.id;
      await hubToJoiner();
      const { openDirectedLedger } = await import('../store/delivery.js');
      expect(
        (await openDirectedLedger(hub.store, (await hubTeam()).id)).map((d) => d.id),
      ).toContain(handoffId);
      // ada answers on the joiner (a store-level accept, as her session would send it).
      const jt = await joinerTeam();
      const ada = (await getMemberByName(joiner.store, jt.id, 'ada'))!;
      const nickOnJoinerRow = (await getMemberByName(joiner.store, jt.id, 'nick'))!;
      await insertMessage(
        joiner.store,
        jt.id,
        ada.id,
        nickOnJoinerRow.id,
        makeEnvelope({
          id: 'ada-accept-1',
          team: 'bravo',
          from: 'ada',
          to: { kind: 'member', name: 'nick' },
          act: 'accept',
          body: 'on it',
          meta: { in_reply_to: handoffId },
          ts: Date.now(),
        }),
      );
      // nick's own fixture message (`j-0`) rides the same batch and nick is bound to the hub, so
      // nick trusts the joiner first — ADR 358's remedy, exercised end to end.
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      expect(
        (await post(hubBase, '/teams/bravo/nodes/trust', { node_id: joinerNode }, nickOnHub))
          .status,
      ).toBe(200);
      await pushTeam(joinerCtx, jt);
      await pullTeam(hubCtx(), await hubTeam());
      expect(
        (await openDirectedLedger(hub.store, (await hubTeam()).id)).map((d) => d.id),
      ).not.toContain(handoffId);
    });
  });
});
