import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { appendAudit } from '../store/audit.js';
import { getLane } from '../store/lanes.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('review-verbs', (_o, kind) => {
  /**
   * ADR 682: the acceptance rail's records cross the wire.
   *
   * The defect: `appendAudit` writes a row with `origin_seq 0`, and the push selects only stamped
   * rows — so `lane.review_sent_back` (ADR 202's rejection record), `lane.review_acknowledged`,
   * `lane.review_advisory` (ADR 667), `lane.claims_verified` (ADR 585), `lane.review_unbound`
   * (ADR 680) and `lane.review_rerouted` (ADR 545) never left the node that wrote them. A lane's
   * history on another machine omitted its rejection.
   *
   * Two claims, and the second is what makes the first safe:
   *  1. the record is whole — a decline written on the joiner is in the HUB's audit, with the
   *     origin's stamp, and in the hub's view of that lane's history;
   *  2. no decision crossed with it — the lane's STATE is the same on both machines, because a
   *     review row projects to nothing.
   *
   * Harness copied from lanes.test.ts so this file stands alone.
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

  /** Joiner pushes to the hub; the hub folds its own staged log (the loopback of pull.ts). */
  async function replicate() {
    await pushTeam(joinerCtx, await joinerTeam());
    await pullTeam(hubCtx(), await hubTeam());
  }

  const auditRows = async (db: any, teamId: string, action: string) =>
    await db.all(
      'SELECT id, target, detail, origin_node, origin_seq FROM audit WHERE team_id = ? AND action = ?',
      [teamId, action],
    );

  /** One review row, written the way the acceptance rail writes it (route.ts). */
  async function reviewRow(action: string, laneId: string) {
    await appendAudit(joiner.store, (await joinerTeam()).id, {
      actor: 'nick',
      action,
      target: laneId,
      result: 'allow',
      detail: { lane: laneId, reviewer: 'nick', owner: 'nick' },
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-review-verbs-'));
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
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the review rows cross (ADR 682)', () => {
    it('a rejection written on the joiner is on the hub, with the origin stamp', async () => {
      const opened = await post(
        joinerBase,
        '/teams/bravo/lanes',
        { title: 'the lane under review', claim: true },
        nickOnJoiner,
      );
      expect(opened.status).toBe(201);
      const laneId: string = opened.json.lane.id;
      await replicate(); // the hub holds the lane before the row names it

      await reviewRow('lane.review_sent_back', laneId);

      // The row is stamped where it was written — that is what makes it cross at all.
      const onJoiner = await auditRows(
        joiner.store,
        (await joinerTeam()).id,
        'lane.review_sent_back',
      );
      expect(onJoiner).toHaveLength(1);
      expect(onJoiner[0].origin_seq).toBeGreaterThan(0);
      expect(onJoiner[0].origin_node).toBeTruthy();

      await replicate();

      const onHub = await auditRows(hub.store, (await hubTeam()).id, 'lane.review_sent_back');
      expect(onHub).toHaveLength(1);
      expect(onHub[0].target).toBe(laneId);
      // The origin's stamp, verbatim: the hub did not write this row.
      expect(onHub[0].origin_node).toBe(onJoiner[0].origin_node);
      expect(onHub[0].origin_seq).toBe(onJoiner[0].origin_seq);
    });

    it('the lane state is the same on both machines — a review row decides nothing', async () => {
      const opened = await post(
        joinerBase,
        '/teams/bravo/lanes',
        { title: 'state must not move', claim: true },
        nickOnJoiner,
      );
      const laneId: string = opened.json.lane.id;
      await replicate();
      await reviewRow('lane.review_sent_back', laneId);
      await replicate();

      const onHub = await getLane(hub.store, (await hubTeam()).id, laneId, 'bravo');
      const onJoiner = await getLane(joiner.store, (await joinerTeam()).id, laneId, 'bravo');
      expect(onHub?.state).toBe(onJoiner?.state);
      expect(onHub?.owner_seat).toBe(onJoiner?.owner_seat);
      expect(onHub?.state).toBe('claimed');
    });

    it('the acceptors claims cross too — the fold has to be able to name the verb', async () => {
      const opened = await post(
        joinerBase,
        '/teams/bravo/lanes',
        { title: 'claims', claim: true },
        nickOnJoiner,
      );
      const laneId: string = opened.json.lane.id;
      await replicate();

      await reviewRow('lane.claims_verified', laneId);
      await replicate();

      const onHub = await auditRows(hub.store, (await hubTeam()).id, 'lane.claims_verified');
      expect(onHub).toHaveLength(1);
      expect(onHub[0].origin_seq).toBeGreaterThan(0);
    });

    it('a verb outside the set stays on the machine that wrote it', async () => {
      const opened = await post(
        joinerBase,
        '/teams/bravo/lanes',
        { title: 'not a review row', claim: true },
        nickOnJoiner,
      );
      const laneId: string = opened.json.lane.id;
      await replicate();

      // `ask.raised` is written through `appendAudit` and is NOT in the declared set, so it keeps
      // the old contract: unstamped, so it never leaves this machine. This is the control — the
      // change is the SET, not the writer: without it every `appendAudit` row would cross.
      await appendAudit(joiner.store, (await joinerTeam()).id, {
        actor: 'nick',
        action: 'ask.raised',
        target: laneId,
        result: 'allow',
        detail: { lane: laneId },
      });
      await replicate();

      const onJoiner = await auditRows(joiner.store, (await joinerTeam()).id, 'ask.raised');
      expect(onJoiner).toHaveLength(1);
      expect(onJoiner[0].origin_seq).toBe(0); // unstamped: the old contract, unchanged
      const onHub = await auditRows(hub.store, (await hubTeam()).id, 'ask.raised');
      expect(onHub).toHaveLength(0); // and so it never crossed
    });
  });
});
