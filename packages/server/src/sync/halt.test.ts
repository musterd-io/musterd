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
import { claimAgentHttp } from '../transport/test-auth.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('halt-sync', (_o, kind) => {
  /**
   * Halt replication (ADR 525) between two real daemons. Before it, ADR 501's halt was a column on
   * the daemon that took the request: a seat halted on the hub kept claiming and calling against a
   * joiner. The falsifiers: a hub halt refuses the seat on the joiner, a resume frees it there, a
   * joiner's halt is the hub's decision and stops the seat on both, and a joiner with the hub down
   * refuses rather than halting the seat on one machine only.
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
    dir = mkdtempSync(join(tmpdir(), 'musterd-halt-sync-'));
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
    const joinerTeamRes = (
      await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json;
    nickOnJoiner = joinerTeamRes.human_credential;
    joinerAgentKey = joinerTeamRes.agent_key;
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

  let joinerAgentKey: string;

  async function addAda() {
    for (const [base, cred] of [
      [hubBase, nickOnHub],
      [joinerBase, nickOnJoiner],
    ] as const) {
      const r = await post(base, '/teams/bravo/members', { name: 'ada', kind: 'agent' }, cred);
      expect(r.status).toBeLessThan(300);
    }
  }
  const haltedOn = async (store: RunningServer['store'], slug = 'bravo') => {
    const t = (await getTeamBySlug(store, slug))!;
    return (await getMemberByName(store, t.id, 'ada'))?.halted_at ?? null;
  };

  describe('halt replication (ADR 525)', () => {
    it('a halt on the hub refuses the seat on the joiner after one round trip', async () => {
      await addAda();
      const ada = await claimAgentHttp(joinerBase, 'bravo', joinerAgentKey, nickOnJoiner, 'ada');
      const halt = await post(
        hubBase,
        '/teams/bravo/members/ada/halt',
        { reason: 'looping on the wrong lane' },
        nickOnHub,
      );
      expect(halt.status).toBe(200);
      expect(await haltedOn(joiner.store)).toBeNull(); // the defect: nothing had crossed

      await roundTrip();

      expect(await haltedOn(joiner.store)).toBe(halt.json.halted.at);
      const call = await fetch(`${joinerBase}/teams/bravo/next`, {
        headers: {
          authorization: `Bearer ${ada.key}`,
          'x-musterd-session-lease': ada.sessionLease,
          'x-musterd-seat': 'ada',
        },
      });
      expect(call.status).toBe(403);
      expect(await call.text()).toContain('halted by nick: looping on the wrong lane');
    });

    it('a resume on the hub frees the seat on the joiner', async () => {
      await addAda();
      await post(hubBase, '/teams/bravo/members/ada/halt', { reason: 'pause' }, nickOnHub);
      await roundTrip();
      expect(await haltedOn(joiner.store)).not.toBeNull();
      const resumed = await post(hubBase, '/teams/bravo/members/ada/resume', undefined, nickOnHub);
      expect(resumed.status).toBe(200);
      await roundTrip();
      expect(await haltedOn(joiner.store)).toBeNull();
    });

    it("a joiner's halt is the hub's decision — the seat is stopped on both machines", async () => {
      await addAda();
      await residentOnJoiner();
      const halt = await post(
        joinerBase,
        '/teams/bravo/members/ada/halt',
        { reason: 'from the laptop' },
        nickOnJoiner,
      );
      expect(halt.status).toBe(200);
      expect(await haltedOn(hub.store)).toBe(halt.json.halted.at);
      // The forward pulled the hub's event back, so this machine enforces it without waiting a tick.
      expect(await haltedOn(joiner.store)).toBe(halt.json.halted.at);
      // The joiner minted no halt event of its own.
      expect(
        await joiner.store.get(
          `SELECT COUNT(*) AS n FROM audit WHERE action = 'seat.halted'
             AND origin_node = (SELECT node_id FROM local_node WHERE team_id = ?)`,
          [(await joinerTeam()).id],
        ),
      ).toEqual({ n: 0 });
    });

    it('a joiner with the hub down REFUSES hub_unreachable and halts nothing locally', async () => {
      await addAda();
      await hub.close();
      const res = await post(
        joinerBase,
        '/teams/bravo/members/ada/halt',
        { reason: 'x' },
        nickOnJoiner,
      );
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('hub_unreachable');
      expect(await haltedOn(joiner.store)).toBeNull();
      hub = createServer({
        db: await openTestDriver(kind, { instance: 'c' }),
        port: 0,
        syncLoops: false,
      });
      await hub.listen();
    });
  });
});
