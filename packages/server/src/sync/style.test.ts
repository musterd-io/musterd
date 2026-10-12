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
import { memberStylePrefs } from '../store/style.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('style', (_o, kind) => {
  /**
   * Style prefs replication (ADR 514, lane 01M46RWP23) between two real daemons — the
   * `policy.test.ts` harness. The lane's trigger: a human on a second machine sets a dial and a
   * seat elsewhere keeps the old block. Falsifiers: the hub's write reaches the joiner; the
   * joiner's own write is decided by the hub and comes back through the fold, with nothing minted
   * locally; a joiner that cannot reach the hub refuses rather than forking; and a node that the
   * human does not live on cannot set their prefs by naming them.
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
  const put = (base: string, path: string, body: unknown, auth: string) =>
    req('PUT', base, path, body, auth);
  const get = (base: string, path: string, auth: string) => req('GET', base, path, undefined, auth);

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

  async function enrollSecondNode(label: string): Promise<{ credential: string }> {
    const { json: minted } = await post(hubBase, '/teams/bravo/nodes/invite', { label }, nickOnHub);
    const { status, json } = await post(hubBase, '/teams/bravo/nodes/join', {
      code: minted.invite,
      node_id: `node-${label.replace(/\W+/g, '-')}`,
      label,
    });
    expect(status).toBe(200);
    return { credential: json.node_credential };
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

  const prefsOn = async (store: RunningServer['store']) =>
    memberStylePrefs(
      (await getMemberByName(store, (await getTeamBySlug(store, 'bravo'))!.id, 'nick'))!,
    );

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-style-sync-'));
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

  describe('style prefs replication (ADR 514, lane 01M46RWP23)', () => {
    it('a dial set on the hub reaches the joiner after one round trip, and its seats read the new block', async () => {
      const set = await put(
        hubBase,
        '/teams/bravo/members/me/style',
        { length: 'concise', prose: 'Lead with the result.' },
        nickOnHub,
      );
      expect(set.status).toBe(200);
      expect(await prefsOn(joiner.store)).toBeUndefined();

      await roundTrip();

      expect(await prefsOn(joiner.store)).toEqual({
        length: 'concise',
        prose: 'Lead with the result.',
      });
      // The trigger, closed: a read on the joiner resolves nick's dials and block from the folded row.
      const joinerRead = await get(joinerBase, '/teams/bravo/members/me/style', nickOnJoiner);
      expect(joinerRead.json.resolved.dials.length).toBe('concise');
      expect(joinerRead.json.block).toContain('nick adds: "Lead with the result."');
    });

    it("a human's write on the JOINER is decided by the hub, stamped there, and comes back through the fold", async () => {
      await residentOnJoiner();

      const set = await put(
        joinerBase,
        '/teams/bravo/members/me/style',
        { bluntness: 'direct' },
        nickOnJoiner,
      );
      expect(set.status).toBe(200);
      expect(set.json.member).toBe('nick');
      expect(set.json.resolved.dials.bluntness).toBe('direct');

      // The hub holds the row and minted the replicated event; the joiner minted nothing.
      expect(await prefsOn(hub.store)).toEqual({ bluntness: 'direct' });
      expect(
        await hub.store.get(
          "SELECT COUNT(*) AS n FROM audit WHERE action = 'style.prefs' AND origin_seq > 0",
        ),
      ).toEqual({ n: 1 });
      // The keys-only observability row is on the hub too, and carries no prose.
      const audited = await hub.store.get<{ detail: string }>(
        "SELECT detail FROM audit WHERE action = 'style.prefs_set'",
      );
      expect(JSON.parse(audited!.detail)).toEqual({ dials: ['bluntness'], prose_lines: 0 });
      expect(
        await joiner.store.get(
          `SELECT COUNT(*) AS n FROM audit WHERE action IN ('style.prefs', 'style.prefs_set')
             AND origin_node = (SELECT node_id FROM local_node WHERE team_id = ?)`,
          [(await joinerTeam()).id],
        ),
      ).toEqual({ n: 0 });

      await roundTrip();
      expect(await prefsOn(joiner.store)).toEqual({ bluntness: 'direct' });
    });

    it('replace semantics survive the fold: a cleared dial is cleared on the joiner', async () => {
      await put(hubBase, '/teams/bravo/members/me/style', { length: 'concise' }, nickOnHub);
      await roundTrip();
      expect(await prefsOn(joiner.store)).toEqual({ length: 'concise' });
      await put(hubBase, '/teams/bravo/members/me/style', {}, nickOnHub);
      await roundTrip();
      expect(await prefsOn(joiner.store)).toEqual({});
    });

    it('a joiner-side write with the hub down REFUSES hub_unreachable and changes nothing', async () => {
      await hub.close();
      const res = await put(
        joinerBase,
        '/teams/bravo/members/me/style',
        { length: 'thorough' },
        nickOnJoiner,
      );
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('hub_unreachable');
      expect(await prefsOn(joiner.store)).toBeUndefined();
      hub = createServer({
        db: await openTestDriver(kind, { instance: 'c' }),
        port: 0,
        syncLoops: false,
      });
      await hub.listen();
    });

    it('the forward is refused when the human lives on a DIFFERENT machine, and for an agent actor', async () => {
      await residentOnJoiner();
      const evil = await enrollSecondNode('someone elses laptop');
      const res = await post(
        hubBase,
        '/teams/bravo/sync/style',
        { actor: 'nick', prefs: { length: 'concise' } },
        evil.credential,
      );
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('bound_elsewhere');
      expect(await prefsOn(hub.store)).toBeUndefined();

      // An agent has no preferences, whichever machine speaks for it.
      await post(hubBase, '/teams/bravo/members', { name: 'Ada', kind: 'agent' }, nickOnHub);
      const agent = await post(
        hubBase,
        '/teams/bravo/sync/style',
        { actor: 'Ada', prefs: { length: 'concise' } },
        evil.credential,
      );
      expect([403, 404]).toContain(agent.status);
    });

    it('six-line prose is refused 422 with the count at the hub, as at the self route', async () => {
      await residentOnJoiner();
      const res = await put(
        joinerBase,
        '/teams/bravo/members/me/style',
        { prose: 'a\nb\nc\nd\ne\nf' },
        nickOnJoiner,
      );
      expect(res.status).toBe(422);
      expect(res.json.error.message).toMatch(/6 lines/);
    });
  });
});
