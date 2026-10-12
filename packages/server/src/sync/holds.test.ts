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

withDrivers('holds-sync', (_o, kind) => {
  /**
   * Hold replication (ADR 516 §4) between two real daemons. Today's autorefresh hold was a file on
   * one machine; a Team hold is the hub's row, and every machine's tick must see the same one. The
   * falsifiers: the hub's hold reaches the joiner, the joiner's admin is decided by the hub, a lift
   * crosses, and a joiner that cannot reach the hub refuses rather than recording a private rule.
   *
   * Harness copied from policy.test.ts so this file stands alone.
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

  /**
   * Make nick resident on the joiner as far as the HUB is concerned — one ordinary act, replicated.
   * Every forwarded hold needs this, and every real admin already has it: the seat lives on
   * the machine its human works from, and the first thing it does there binds it.
   */
  async function residentOnJoiner() {
    const opened = await post(
      joinerBase,
      '/teams/bravo/lanes',
      { title: 'nick works from this laptop', claim: true },
      nickOnJoiner,
    );
    expect(opened.status).toBe(201);
    await roundTrip();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-holds-sync-'));
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
    nickOnHub = (
      await post(hubBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    nickOnJoiner = (
      await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    // The joiner's node row is minted on its first logged act, and enrollment needs one.
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
    await enrollJoiner();
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(base: string, path: string, auth: string) {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${auth}` } });
    return (await res.json()) as any;
  }
  const demo = { effect: 'autorefresh_paused', reason: 'demo 14:00', for_ms: 90 * 60_000 };

  describe('hold replication (ADR 516)', () => {
    it("the hub's hold reaches the joiner after one round trip, same id, same author", async () => {
      const set = await post(hubBase, '/teams/bravo/holds', demo, nickOnHub);
      expect(set.status).toBe(200);
      expect((await get(joinerBase, '/teams/bravo/holds', nickOnJoiner)).holds).toEqual([]);

      await roundTrip();

      const there = (await get(joinerBase, '/teams/bravo/holds', nickOnJoiner)).holds;
      expect(there).toEqual([set.json.hold]);
    });

    it('a lift on the hub ends it on the joiner, and the fold is idempotent', async () => {
      const { json } = await post(hubBase, '/teams/bravo/holds', demo, nickOnHub);
      await roundTrip();
      await post(hubBase, `/teams/bravo/holds/${json.hold.id}/lift`, undefined, nickOnHub);
      await roundTrip();
      await roundTrip();
      expect((await get(joinerBase, '/teams/bravo/holds', nickOnJoiner)).holds).toEqual([]);
      const all = (await get(joinerBase, '/teams/bravo/holds?all=1', nickOnJoiner)).holds;
      expect(all).toHaveLength(1);
      expect(all[0].lifted_by).toBe('nick');
    });

    it("the joiner's admin sets a hold: the hub decides and mints it, the joiner reads it back", async () => {
      await residentOnJoiner();
      const set = await post(joinerBase, '/teams/bravo/holds', demo, nickOnJoiner);
      expect(set.status).toBe(200);
      // The hub's row is the fact; the joiner minted no hold event of its own.
      expect(
        (await get(hubBase, '/teams/bravo/holds', nickOnHub)).holds.map((h: any) => h.id),
      ).toEqual([set.json.hold.id]);
      expect(
        await joiner.store.get(
          `SELECT COUNT(*) AS n FROM audit WHERE action = 'hold.set'
             AND origin_node = (SELECT node_id FROM local_node WHERE team_id = ?)`,
          [(await joinerTeam()).id],
        ),
      ).toEqual({ n: 0 });
      // …and the forward pulled the answer back, so the admin's next read agrees with it.
      expect(
        (await get(joinerBase, '/teams/bravo/holds', nickOnJoiner)).holds.map((h: any) => h.id),
      ).toEqual([set.json.hold.id]);
    });

    it('a joiner with the hub down REFUSES hub_unreachable and records no private hold', async () => {
      await hub.close();
      const res = await post(joinerBase, '/teams/bravo/holds', demo, nickOnJoiner);
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('hub_unreachable');
      expect(await joiner.store.get('SELECT COUNT(*) AS n FROM holds')).toEqual({ n: 0 });
      hub = createServer({
        db: await openTestDriver(kind, { instance: 'c' }),
        port: 0,
        syncLoops: false,
      });
      await hub.listen();
    });
  });
});
