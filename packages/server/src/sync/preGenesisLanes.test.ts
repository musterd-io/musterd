import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('preGenesisLanes', (_o, kind) => {
  /**
   * ADR 544. A hub's replicated history begins at its first logged `lane.opened` (`lane_genesis`);
   * lanes born before it exist on the hub and nowhere else, and a joiner's inbox keeps every ask or
   * handoff naming one owed forever. Harness copied from policy.test.ts; the pre-genesis lane is
   * made by erasing one lane's birth from the hub's log, which is what history before the log
   * looks like from a joiner.
   */
  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickOnHub: string;
  let nickOnJoiner: string;
  let dir: string;
  let joinerCtx: Ctx;

  async function post(base: string, path: string, body?: unknown, auth?: string) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
  }
  const hubCtx = (): Ctx => ({
    db: hub.store,
    hub: new Hub(),
    config: resolveConfig(),
    rosterRoots: [],
  });
  const hubTeam = async () => (await getTeamBySlug(hub.store, 'bravo'))!;
  const joinerTeam = async () => (await getTeamBySlug(joiner.store, 'bravo'))!;

  async function roundTrip() {
    await pushTeam(joinerCtx, await joinerTeam());
    await pullTeam(hubCtx(), await hubTeam());
    await pushTeam(hubCtx(), await hubTeam());
    await pullTeam(joinerCtx, await joinerTeam());
  }

  async function enrollJoiner() {
    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'joiner' },
      nickOnHub,
    );
    const res = await post(joinerBase, '/node/enroll', {
      hub_url: hubBase,
      code: minted.invite,
      team: 'bravo',
    });
    expect(res.status).toBe(200);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-pregenesis-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
    hub = createServer({ db: await openTestDriver(kind), port: 0 });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({ db: await openTestDriver(kind, { instance: 'b' }), port: 0 });
    joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
    joinerCtx = { db: joiner.store, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };
    nickOnHub = (
      await post(hubBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    nickOnJoiner = (
      await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    const jt = await joinerTeam();
    await insertMessage(
      joiner.store,
      jt.id,
      (await getMemberByName(joiner.store, jt.id, 'nick'))!.id,
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
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe("a joiner learns the hub's pre-genesis lanes (ADR 544)", () => {
    it('adopts a lane whose birth the log never held, in its current state, and does not touch one it has', async () => {
      // Two lanes on the hub before any joiner exists. `ancient` is then closed; its BIRTH is erased
      // from the hub's log, so genesis moves to `recent` and `ancient` becomes pre-history.
      const ancient = (
        await post(hubBase, '/teams/bravo/lanes', { title: 'ancient', claim: true }, nickOnHub)
      ).json.lane;
      const recent = (
        await post(hubBase, '/teams/bravo/lanes', { title: 'recent', claim: true }, nickOnHub)
      ).json.lane;
      const closed = await fetch(`${hubBase}/teams/bravo/lanes/${ancient.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${nickOnHub}` },
        body: JSON.stringify({ state: 'done' }),
      });
      expect(closed.status).toBe(200);
      const ht = await hubTeam();
      await hub.store.run(
        `DELETE FROM sync_log WHERE team_id = ? AND json_extract(payload, '$.event.action') = 'lane.opened'
           AND COALESCE(json_extract(payload, '$.event.detail.lane'), json_extract(payload, '$.event.target')) = ?`,
        [ht.id, ancient.id],
      );

      await enrollJoiner();
      await roundTrip();

      const jt = await joinerTeam();
      const rows = await joiner.store.all<{
        id: string;
        title: string;
        state: string;
        owner_seat: string | null;
      }>('SELECT id, title, state, owner_seat FROM lanes WHERE team_id = ? ORDER BY id', [jt.id]);
      // `recent` arrived through the log as usual; `ancient` arrived whole through the snapshot,
      // already `done` — the state the hub holds NOW, not the one it was born in.
      expect(rows.map((r) => r.title)).toEqual(['ancient', 'recent']);
      expect(rows.find((r) => r.title === 'ancient')).toMatchObject({
        id: ancient.id,
        state: 'done',
        owner_seat: 'nick',
      });
      expect(rows.find((r) => r.title === 'recent')).toMatchObject({
        id: recent.id,
        state: 'claimed',
      });

      // Stateless and idempotent: another round trip adopts nothing and overwrites nothing.
      await joiner.store.run('UPDATE lanes SET title = ? WHERE id = ?', [
        'ancient (local edit)',
        ancient.id,
      ]);
      await roundTrip();
      const again = await joiner.store.get<{ title: string; n: number }>(
        'SELECT (SELECT title FROM lanes WHERE id = ?) AS title, COUNT(*) AS n FROM lanes WHERE team_id = ?',
        [ancient.id, jt.id],
      );
      expect(again).toEqual({ title: 'ancient (local edit)', n: 2 });
    });

    it('a hub with no pre-genesis lanes reports 0 and the joiner asks for nothing', async () => {
      await post(hubBase, '/teams/bravo/lanes', { title: 'only', claim: true }, nickOnHub);
      await enrollJoiner();
      // The hub stages its own history once it has a joiner (ADR 398's loopback arm); genesis is
      // read from that staged log, so one round trip is what makes it non-null.
      await roundTrip();
      const { json: minted } = await post(
        hubBase,
        '/teams/bravo/nodes/invite',
        { label: 'probe' },
        nickOnHub,
      );
      const { json } = await post(hubBase, '/teams/bravo/nodes/join', {
        code: minted.invite,
        node_id: 'node-probe',
        label: 'probe',
      });
      const page = await fetch(`${hubBase}/teams/bravo/sync/pull?after=0`, {
        headers: { authorization: `Bearer ${json.node_credential}` },
      }).then(
        (r) => r.json() as Promise<{ pre_genesis_lanes: number; lane_genesis: string | null }>,
      );
      expect(page.lane_genesis).not.toBeNull();
      expect(page.pre_genesis_lanes).toBe(0);
      const snapshot = await fetch(`${hubBase}/teams/bravo/sync/lanes`, {
        headers: { authorization: `Bearer ${json.node_credential}` },
      }).then((r) => r.json() as Promise<{ lanes: unknown[] }>);
      expect(snapshot.lanes).toEqual([]);
      // and a member credential is refused — the snapshot is a machine's read
      const refused = await fetch(`${hubBase}/teams/bravo/sync/lanes`, {
        headers: { authorization: `Bearer ${nickOnHub}` },
      });
      expect(refused.status).toBe(401);
      void nickOnJoiner;
    });
  });
});
