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
import { toMember } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('statusLine sync', (_o, kind) => {
  /**
   * ADR 721 Decision 5: a human's status line on a team that spans machines — the hub's copy is the
   * one shown. A set on the hub reaches a joiner; a set on a joiner is decided by the hub and comes
   * back through the fold; a joiner that cannot reach the hub refuses rather than keep a local copy.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickOnHub: string;
  let nickOnJoiner: string;
  let dir: string;
  let joinerCtx: Ctx;

  async function req(method: string, base: string, path: string, body?: unknown, auth?: string) {
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
  const post = (base: string, path: string, body?: unknown, auth?: string) =>
    req('POST', base, path, body, auth);

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

  /** nick resident on the joiner as far as the hub knows — one ordinary act, replicated. */
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

  const lineOn = async (store: RunningServer['store']) =>
    toMember(
      (await getMemberByName(store, (await getTeamBySlug(store, 'bravo'))!.id, 'nick'))!,
      'bravo',
    ).status_line ?? null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-status-line-sync-'));
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
    await enrollJoiner();
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe('status line replication (ADR 721)', () => {
    it('a status set on the hub reaches the joiner after one round trip', async () => {
      // the joiner's own history first: setting it touches nick's presence on the hub, which then
      // holds his seat, and a later push of the joiner's old act would be refused as bound elsewhere
      await roundTrip();
      const set = await post(
        hubBase,
        '/teams/bravo/status-line',
        { text: 'at the vet' },
        nickOnHub,
      );
      expect(set.status).toBe(200);
      expect(await lineOn(joiner.store)).toBeNull();
      await roundTrip();
      expect((await lineOn(joiner.store))?.text).toBe('at the vet');
      await req('DELETE', hubBase, '/teams/bravo/status-line', undefined, nickOnHub);
      await roundTrip();
      expect(await lineOn(joiner.store)).toBeNull();
    });

    it('a status set on the JOINER is decided by the hub, and comes back through the fold', async () => {
      await residentOnJoiner();
      const set = await post(
        joinerBase,
        '/teams/bravo/status-line',
        { text: 'assembling a dresser' },
        nickOnJoiner,
      );
      expect(set.status).toBe(200);
      expect((await lineOn(hub.store))?.text).toBe('assembling a dresser');
      // the hub's clock sets the hour, and the setter's own machine shows it straight away
      expect(set.json.member.status_line.text).toBe('assembling a dresser');
      await roundTrip();
      expect((await lineOn(joiner.store))?.text).toBe('assembling a dresser');
    });

    it('a joiner-side set with the hub down REFUSES hub_unreachable and changes nothing', async () => {
      await hub.close();
      const res = await post(
        joinerBase,
        '/teams/bravo/status-line',
        { text: 'gone fishing' },
        nickOnJoiner,
      );
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('hub_unreachable');
      expect(await lineOn(joiner.store)).toBeNull();
      hub = createServer({
        db: await openTestDriver(kind, { instance: 'c' }),
        port: 0,
        syncLoops: false,
      });
      await hub.listen();
    });
  });
});
