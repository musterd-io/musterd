import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_PRESENCE_TTL_MS, resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { type Database } from '../db/open.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { getLane, updateLane } from '../store/lanes.js';
import { addMember, getMemberByName, mintCredential } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { unbindSeat } from '../store/nodes.js';
import {
  attach,
  clearMemberPresence,
  detach,
  hasLivePresence,
  listPresence,
  reapStale,
  reattestModel,
  reattestSurface,
  touchAmbientPresence,
} from '../store/presence.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('presence', (_o, kind) => {
  /**
   * Presence replication (spec 2026-09-02, ADR 356): `presence.*` is the third replicated kind, so
   * every machine's roster shows every seat on every machine and the hub's displacement rule sees
   * remote seats. These are the spec's falsifiers 1–7, run between two real daemons; falsifier 8 is
   * the store suite's "a remote row is never the subject of a locally emitted transition".
   *
   * Harness copied from claim.test.ts so this file stands alone.
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
  const joinerNode = () => readNodeState().nodes['bravo']!.node_id;

  const memberId = async (db: Database, teamId: string, name: string) =>
    (await getMemberByName(db, teamId, name))!.id;

  /** joiner → hub → joiner: push, the hub folds its staging, the hub stages its own, the joiner pulls. */
  async function roundTrip() {
    await pushTeam(joinerCtx, await joinerTeam());
    await pullTeam(hubCtx(), await hubTeam());
    await pushTeam(hubCtx(), await hubTeam());
    await pullTeam(joinerCtx, await joinerTeam());
  }

  const presenceOf = async (db: Database, teamId: string, name: string) =>
    (await listPresence(db, teamId, 45_000)).find((s) => s.member.name === name)!;

  /** A lane born on the hub, unowned, visible on both machines. */
  async function laneOnBoth(title = 'shared'): Promise<string> {
    // Opened by hana, not nick: since push-level residence (2026-09-02) every kind binds at ingest,
    // so a lane nick opened here would bind nick to the hub at the loopback push and the joiner's
    // claim as nick would be `bound_elsewhere` — the rule working, against a premise these cases
    // set differently (nick lives on the joiner).
    const opened = await post(hubBase, '/teams/bravo/lanes', { title }, hanaOnHub);
    expect(opened.status).toBe(201);
    const id: string = opened.json.lane.id;
    await pushTeam(hubCtx(), await hubTeam());
    await pullTeam(joinerCtx, await joinerTeam());
    expect(await getLane(joiner.store, (await joinerTeam()).id, id, 'bravo')).toMatchObject({
      id,
      owner_seat: null,
    });
    return id;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-presence-'));
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
    await insertMessage(
      joiner.store,
      jt.id,
      await memberId(joiner.store, jt.id, 'nick'),
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
    // own staging binds nick to the hub's node at ingest (§2). The claim cases below have nick
    // living on the joiner, so take that touch now, stage it, and release the fixture's binding.
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

  describe('presence replication — every machine sees every seat', () => {
    it('1. a seat attached on the joiner is live on the hub with its facets and its node', async () => {
      const row = await attach(
        joiner.store,
        await memberId(joiner.store, (await joinerTeam()).id, 'ada'),
        'codex',
        'c1',
        {
          model: 'gpt-5',
          model_source: 'observed',
          driver: 'nick',
          workspace: '~/b',
        },
      );
      await roundTrip();
      const onHub = await presenceOf(hub.store, (await hubTeam()).id, 'ada');
      expect(onHub.status).toBe('online');
      expect(onHub.presences[0]).toMatchObject({
        surface: 'codex',
        model: 'gpt-5',
        driver: 'nick',
        workspace: '~/b',
        node: joinerNode(),
        // The node's label is the machine's own name, stamped at enrollment — not the invite's.
        node_label: hostname(),
      });
      expect(
        await hasLivePresence(
          hub.store,
          await memberId(hub.store, (await hubTeam()).id, 'ada'),
          45_000,
        ),
      ).toBe(true);
      expect(row.node).toBeNull();
    });

    it("2. a claim against a lane held by a seat live on the joiner is refused naming the holder — ADR 355 §4's hole, closed", async () => {
      const laneId = await laneOnBoth();
      await updateLane(
        hub.store,
        (await hubTeam()).id,
        laneId,
        'bravo',
        { owner_seat: 'ada' },
        5,
        undefined,
        {
          // hana, not ada: the hub's push loop stages this write in the background and binds its
          // actor to the hub at ingest, which would refuse the joiner's push of ada's attach below
          // as bound_elsewhere. hana is the hub-resident seat; nothing here needs the actor to be ada.
          actor: 'hana',
        },
      );
      await attach(
        joiner.store,
        await memberId(joiner.store, (await joinerTeam()).id, 'ada'),
        'codex',
        'c1',
      );
      await roundTrip();
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      expect(res.status).toBe(409);
      expect(res.json.holder).toBe('ada');
      expect(res.json.error.message).toContain('live');
    });

    it('3. after the joiner goes quiet past the TTL the same claim succeeds, the row is gone, and nothing wrote a detached', async () => {
      const laneId = await laneOnBoth();
      await updateLane(
        hub.store,
        (await hubTeam()).id,
        laneId,
        'bravo',
        { owner_seat: 'ada' },
        5,
        undefined,
        {
          // hana, not ada: the hub's push loop stages this write in the background and binds its
          // actor to the hub at ingest, which would refuse the joiner's push of ada's attach below
          // as bound_elsewhere. hana is the hub-resident seat; nothing here needs the actor to be ada.
          actor: 'hana',
        },
      );
      await attach(
        joiner.store,
        await memberId(joiner.store, (await joinerTeam()).id, 'ada'),
        'codex',
        'c1',
      );
      await roundTrip();
      await hub.store.run('UPDATE nodes SET last_seen_at = ? WHERE id = ?', [
        Date.now() - REMOTE_PRESENCE_TTL_MS - 1,
        joinerNode(),
      ]);
      await reapStale(hub.store, 45_000);
      expect((await presenceOf(hub.store, (await hubTeam()).id, 'ada')).status).toBe('offline');
      const res = await patch(
        joinerBase,
        `/teams/bravo/lanes/${laneId}`,
        { owner_seat: 'nick' },
        nickOnJoiner,
      );
      // The claim route itself touches the node; the rule ran against the swept table first.
      expect(res.status).toBe(200);
      expect(
        await hub.store.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.detached'"),
      ).toEqual({ n: 0 });
    });

    it("4. a detach on the joiner removes the row on the hub; the hub holds the joiner's detached row and wrote none of its own", async () => {
      const row = await attach(
        joiner.store,
        await memberId(joiner.store, (await joinerTeam()).id, 'ada'),
        'codex',
        'c1',
      );
      await roundTrip();
      expect(
        await hub.store.get('SELECT COUNT(*) AS n FROM presence WHERE id = ?', [row.id]),
      ).toEqual({
        n: 1,
      });
      await detach(joiner.store, row.id);
      await roundTrip();
      expect(
        await hub.store.get('SELECT COUNT(*) AS n FROM presence WHERE id = ?', [row.id]),
      ).toEqual({
        n: 0,
      });
      const det = await hub.store.all(
        "SELECT origin_node FROM audit WHERE action = 'presence.detached'",
      );
      expect(det).toEqual([{ origin_node: joinerNode() }]);
    });

    it('5. a reattest on the joiner changes model and surface on the hub', async () => {
      const row = await attach(
        joiner.store,
        await memberId(joiner.store, (await joinerTeam()).id, 'ada'),
        'codex',
        'c1',
        {
          model: 'gpt-5',
          model_source: 'observed',
        },
      );
      await roundTrip();
      await reattestModel(joiner.store, row.id, 'gpt-5-mini', 'observed');
      await reattestSurface(joiner.store, row.id, 'cli');
      await roundTrip();
      expect(
        await hub.store.get('SELECT model, surface FROM presence WHERE id = ?', [row.id]),
      ).toEqual({
        model: 'gpt-5-mini',
        surface: 'cli',
      });
    });

    // ADR 384 rewrote this one: the reattest half no longer stops. The row it waited for is one the
    // receiving daemon reaps itself during a long replay, so the wait never ended — and a stop that
    // cannot clear is a wedge, not a guard. The batch now advances and invents nothing.
    it('6. a reattested whose attach never folded advances with its audit row, and so does a detached', async () => {
      // Drain the joiner's j-0 first so the ghost is the next seq and the only thing the fold meets.
      await pushTeam(joinerCtx, await joinerTeam());
      await pullTeam(hubCtx(), await hubTeam());
      const enrolled = readNodeState().nodes['bravo']!;
      const head = (await hub.store.get(
        'SELECT MAX(origin_seq) AS high FROM sync_log WHERE origin_node = ?',
        [enrolled.node_id],
      ))!.high;
      const ghost = (id: string, seq: number, action: string, detail: Record<string, unknown>) => ({
        kind: 'presence',
        team: 'bravo',
        origin_node: enrolled.node_id,
        origin_seq: seq,
        event: { id, ts: 1, actor: 'ada', action, target: 'ada', result: 'allow', detail },
      });
      const re = await post(
        hubBase,
        '/teams/bravo/sync/push',
        {
          events: [
            ghost('ghost-re', head + 1, 'presence.reattested', {
              presence: 'ghost',
              model: 'x',
              model_source: null,
              surface: 'cli',
            }),
          ],
        },
        enrolled.credential,
      );
      expect(re.status).toBe(200);
      expect(re.json.accepted).toBe(1);
      expect(await pullTeam(hubCtx(), await hubTeam())).toBe(1);
      expect(await hub.store.get("SELECT COUNT(*) AS n FROM audit WHERE id = 'ghost-re'")).toEqual({
        n: 1,
      });
      expect(await hub.store.get("SELECT COUNT(*) AS n FROM presence WHERE id = 'ghost'")).toEqual({
        n: 0,
      });
      // And the fold keeps moving: a detached for the same ghost, staged behind it, applies too
      // rather than queueing behind a stop that would never clear.
      const det = await post(
        hubBase,
        '/teams/bravo/sync/push',
        {
          events: [
            ghost('ghost-det', head + 2, 'presence.detached', {
              presence: 'ghost',
              reason: 'reaped',
            }),
          ],
        },
        enrolled.credential,
      );
      expect(det.status).toBe(200);
      expect(await pullTeam(hubCtx(), await hubTeam())).toBe(1);
      expect(await hub.store.get("SELECT COUNT(*) AS n FROM audit WHERE id = 'ghost-det'")).toEqual(
        {
          n: 1,
        },
      );
    });

    it('7. a fresh hello for a seat on the joiner clears its local rows with reason cleared and leaves the hub-origin row alone', async () => {
      const hubAda = await attach(
        hub.store,
        await memberId(hub.store, (await hubTeam()).id, 'ada'),
        'claude-code',
        'h1',
      );
      await roundTrip();
      expect(
        await joiner.store.get('SELECT node FROM presence WHERE id = ?', [hubAda.id]),
      ).toMatchObject({ node: expect.any(String) });
      const adaJ = await memberId(joiner.store, (await joinerTeam()).id, 'ada');
      const local = await attach(joiner.store, adaJ, 'codex', 'c1');
      await clearMemberPresence(joiner.store, adaJ);
      expect(
        await joiner.store.get('SELECT COUNT(*) AS n FROM presence WHERE id = ?', [local.id]),
      ).toEqual({ n: 0 });
      expect(
        await joiner.store.get('SELECT COUNT(*) AS n FROM presence WHERE id = ?', [hubAda.id]),
      ).toEqual({ n: 1 });
      expect(
        (
          await joiner.store.all(
            "SELECT detail FROM audit WHERE action = 'presence.detached' AND origin_node = ?",
            [joinerNode()],
          )
        ).map((r) => JSON.parse(r.detail)),
      ).toEqual([{ presence: local.id, reason: 'cleared' }]);
    });
  });
});
