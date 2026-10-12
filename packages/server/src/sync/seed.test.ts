import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope, type SyncPullEvent } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { appendReplicatedEvent } from '../store/audit.js';
import { addMember, getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { claimSeed, createSeedFromRelay, getSeed } from '../store/seeds.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { foldBatch } from './fold.js';
import { readStaged } from './log.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('seed', (_o, kind) => {
  /**
   * The seed kind (ADR 399) between two real daemons.
   *
   * ADR 371 §3 decided a seed reaches a second machine by that machine polling the relay itself, and
   * `seed_unborn` covered the window. Measured 2026-09-14/15 the premise did not hold: the ingest
   * loop is gated on `policy.seeds_relay_url` + `seeds_relay_token`, so a joiner without the relay's
   * bearer token never ingests, and its `seeds` table stays empty forever while the hub's fills. The
   * team was already shipping the COMMENTS on seeds (`record.seed_thread`) across machines while the
   * seeds themselves stayed put.
   *
   * So the capture crosses as its own kind, hub-minted: the joiner holds the team's ideation without
   * holding the relay credential — which is the constraint ADR 390 and 344 set. These are the ADR's
   * falsifiers: a capture ingested at the hub appears on the joiner under the same `relay_id`; a
   * joiner-minted `seed` is refused at ingest as a policy event is; lifecycle state does not ride
   * along; and re-delivery does not duplicate.
   *
   * Harness copied from record.test.ts so this file stands alone.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickOnHub: string;
  let _nickOnJoiner: string;
  let dir: string;
  let joinerCtx: Ctx;

  async function call(
    method: 'POST' | 'PUT' | 'DELETE' | 'GET',
    base: string,
    path: string,
    body?: unknown,
    auth?: string,
  ) {
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
    await call('POST', base, path, body, auth);

  const hubCtx = (): Ctx => ({
    db: hub.store,
    hub: new Hub(),
    config: resolveConfig(),
    rosterRoots: [],
  });
  const hubTeam = async () => (await getTeamBySlug(hub.store, 'bravo'))!;
  const joinerTeam = async () => (await getTeamBySlug(joiner.store, 'bravo'))!;
  const member = async (db: Driver, team: { id: string }, name: string) =>
    (await getMemberByName(db, team.id, name))!;

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

  /** A message on the joiner FROM a seat, inserted directly — no route-time hooks run. */
  async function messageOnJoiner(
    from: string,
    id: string,
    ts: number,
    act: 'message' | 'status_update' = 'message',
    meta: Record<string, unknown> | null = null,
  ) {
    const jt = await joinerTeam();
    await insertMessage(
      joiner.store,
      jt.id,
      (await member(joiner.store, jt, from)).id,
      null,
      makeEnvelope({
        id,
        team: 'bravo',
        from,
        to: { kind: 'team' },
        act,
        body: id,
        ts,
        ...(meta ? { meta } : {}),
      }),
    );
  }

  const RELAY = {
    id: 'relay-1',
    source: 'slack',
    body: 'A raw idea',
    ts: 1,
    meta: { user: 'U123' },
  } as const;

  const count = async (db: Driver, sql: string): Promise<number> =>
    ((await db.get(sql)) as { n: number }).n;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-record-sync-'));
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
    _nickOnJoiner = (
      await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    // The same roster on both machines (git-replicated in life, ADR 058): an agent seat and a human
    // with a Slack id, so the seed relay accepts a submitter and an agent can explore.
    await addMember(hub.store, await hubTeam(), { name: 'ada', kind: 'agent' });
    await addMember(hub.store, await hubTeam(), {
      name: 'sam',
      kind: 'human',
      slackUserId: 'U123',
    });
    await addMember(joiner.store, await joinerTeam(), { name: 'ada', kind: 'agent' });
    await addMember(joiner.store, await joinerTeam(), {
      name: 'sam',
      kind: 'human',
      slackUserId: 'U123',
    });
    // The joiner's node row is minted on its first logged act, and enrollment needs one. This also
    // makes nick resident on the joiner (the first pushed act binds), so nick acts from there below.
    await messageOnJoiner('nick', 'j-0', 1000);
    await enrollJoiner();
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  const seedRow = async (db: Driver, teamId: string, relayId: string) =>
    await db.get(
      'SELECT id, body, source, state, submitted_by FROM seeds WHERE team_id = ? AND relay_id = ?',
      [teamId, relayId],
    );

  describe('the seed kind (ADR 399)', () => {
    it('a capture ingested at the hub reaches the joiner under the same relay_id', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      expect(await count(joiner.store, 'SELECT COUNT(*) AS n FROM seeds')).toBe(0);

      const onHub = await createSeedFromRelay(hub.store, ht.id, RELAY);
      await roundTrip();

      const onJoiner = await seedRow(joiner.store, jt.id, RELAY.id)!;
      expect(onJoiner).toBeTruthy();
      expect(onJoiner.body).toBe('A raw idea');
      expect(onJoiner.source).toBe('slack');
      // Daemon-private ids — which is exactly why the event is keyed by relay_id.
      expect(onJoiner.id).not.toBe(onHub.id);
      // The submitter resolved to the joiner's OWN member row for the same human.
      expect(onJoiner.submitted_by).toBe((await member(joiner.store, jt, 'sam')).id);
    });

    it('re-delivering the same batch does not duplicate the seed', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      await createSeedFromRelay(hub.store, ht.id, RELAY);
      await roundTrip();
      expect(await count(joiner.store, 'SELECT COUNT(*) AS n FROM seeds')).toBe(1);

      const replay = await foldBatch(
        joiner.store,
        jt.id,
        await readStaged(joiner.store, jt.id, 0, 200),
      );
      expect(replay.applied).toBe(0);
      expect(await count(joiner.store, 'SELECT COUNT(*) AS n FROM seeds')).toBe(1);
    });

    it('lifecycle does NOT cross with the capture — the claim stays where it was made', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      const onHub = await createSeedFromRelay(hub.store, ht.id, RELAY);
      await roundTrip();

      // Claim it on the HUB. The explorer claim is "exactly one holder", a residence-1 question this
      // ADR deliberately leaves to the federation increment (ADR 371 §3 stands).
      await claimSeed(hub.store, ht.id, onHub.id, await member(hub.store, ht, 'ada'));
      await roundTrip();

      expect((await getSeed(hub.store, ht.id, onHub.id))!.state).toBe('exploring');
      expect((await seedRow(joiner.store, jt.id, RELAY.id))!.state).toBe('open');
    });

    it('a thread entry folded before its seed is held, and the folded capture projects it (ADR 500)', async () => {
      const jt = await joinerTeam();
      // The order a fresh joiner meets when an entry was written on a seed whose capture reached the
      // log AFTER it — or never, for a seed captured before ADR 399. Before ADR 500 the entry stopped
      // the batch as `seed_unborn`, so the capture behind it could never fold: a wedge.
      const at = Date.now();
      const ev = (seq: number, kind: 'record' | 'seed', event: Record<string, unknown>) =>
        ({
          kind,
          team: 'bravo',
          hub_seq: 990_000 + seq,
          origin_node: 'node-elsewhere',
          origin_seq: seq,
          event: { ts: at, result: 'allow', target: RELAY.id, ...event },
        }) as SyncPullEvent;
      const entry = ev(1, 'record', {
        id: 'entry-early',
        actor: 'ada',
        action: 'record.seed_thread',
        detail: {
          entry_id: 'entry-early',
          relay_id: RELAY.id,
          kind: 'brief',
          body: 'written before the capture folded',
          by: 'ada',
          created_at: at,
        },
      });
      const capture = ev(2, 'seed', {
        id: 'capture-late',
        actor: 'sam',
        action: 'seed.captured',
        detail: {
          relay_id: RELAY.id,
          source: 'slack',
          body: 'A raw idea',
          captured_at: at,
          slack_user_id: null,
          by: 'sam',
          linked_lane_id: null,
          promotion_kind: null,
          created_at: at,
        },
      });

      const result = await foldBatch(joiner.store, jt.id, [entry, capture]);
      expect(result.stop).toBeNull();
      expect(result.last_hub_seq).toBe(990_002);
      expect(result.held_seed_threads).toEqual([{ relay_id: RELAY.id, hub_seq: 990_001 }]);
      const seed = (await seedRow(joiner.store, jt.id, RELAY.id))!;
      expect((await getSeed(joiner.store, jt.id, seed.id))!.thread).toMatchObject([
        { id: 'entry-early', kind: 'brief', by: 'ada' },
      ]);

      // The control: an entry whose seed IS here projects at once and is not reported held.
      const later = ev(3, 'record', {
        id: 'entry-on-time',
        actor: 'ada',
        action: 'record.seed_thread',
        detail: {
          entry_id: 'entry-on-time',
          relay_id: RELAY.id,
          kind: 'conclusion',
          body: 'written after',
          by: 'ada',
          created_at: at + 1,
        },
      });
      const onTime = await foldBatch(joiner.store, jt.id, [later]);
      expect(onTime.held_seed_threads).toEqual([]);
      expect((await getSeed(joiner.store, jt.id, seed.id))!.thread).toHaveLength(2);
    });

    it('a joiner-minted seed event is refused at ingest, as a policy event is', async () => {
      const jt = await joinerTeam();
      // Stamped through the joiner's OWN writer, so the batch is well-formed and the refusal is the
      // origin rule rather than a validation accident.
      await appendReplicatedEvent(joiner.store, jt.id, {
        actor: 'sam',
        action: 'seed.captured',
        target: 'relay-forged',
        result: 'allow',
        detail: {
          relay_id: 'relay-forged',
          source: 'slack',
          body: 'not the hub to mint',
          captured_at: 1,
          slack_user_id: 'U123',
          by: 'sam',
          linked_lane_id: null,
          promotion_kind: null,
        },
      });

      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow();
      expect(
        await count(hub.store, "SELECT COUNT(*) AS n FROM seeds WHERE relay_id = 'relay-forged'"),
      ).toBe(0);
    });
  });
});
