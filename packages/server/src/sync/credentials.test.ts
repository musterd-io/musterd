import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { addMember, getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('credentials', (_o, kind) => {
  /**
   * ADR 689: sponsor-scoped credentials replicate to joiners. A host key the sponsor minted on the
   * hub is honoured by the joiner's own daemon after one round trip — that is what lets a cloud
   * agent machine (ADR 647 phase 2b) run the phase-1 provisioner against `127.0.0.1` with no human
   * identity on it. Harness copied from ledger.test.ts so this file stands alone.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickOnHub: string;
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

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-credentials-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

    hub = createServer({ db: await openTestDriver(kind), port: 0, syncLoops: false });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({
      db: await openTestDriver(kind, { instance: 'b' }),
      port: 0,
      syncLoops: false,
    });
    joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
    joinerCtx = { db: joiner.store, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };

    nickOnHub = (
      await post(hubBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } });
    await addMember(hub.store, await hubTeam(), { name: 'ada', kind: 'agent' });
    await addMember(joiner.store, await joinerTeam(), { name: 'ada', kind: 'agent' });

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
    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'agent machine' },
      nickOnHub,
    );
    expect(
      (
        await post(joinerBase, '/node/enroll', {
          hub_url: hubBase,
          code: minted.invite,
          team: 'bravo',
        })
      ).status,
    ).toBe(200);
  });

  afterEach(async () => {
    await hub.close().catch(() => undefined);
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe('ADR 689 — a hub-minted sponsor host key is honoured at the joiner', () => {
    it('1. a host key minted on the hub authenticates a wake-lease poll at the joiner after one round trip', async () => {
      const hk = await post(
        hubBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'host', target: 'cloud-ada' },
        nickOnHub,
      );
      expect(hk.status).toBe(201);
      const hostKey = hk.json.agent_key as string;

      const before = await post(
        joinerBase,
        '/teams/bravo/residency/wake-leases',
        { host: 'cloud-ada' },
        hostKey,
      );
      expect(before.status).toBe(401);

      await roundTrip();

      const after = await post(
        joinerBase,
        '/teams/bravo/residency/wake-leases',
        { host: 'cloud-ada' },
        hostKey,
      );
      expect(after.status).toBe(200);
    });
  });
});
