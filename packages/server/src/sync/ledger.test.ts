import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { type Database } from '../db/open.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { appendAudit } from '../store/audit.js';
import { deriveWakeMetrics } from '../store/insights.js';
import { addMember, getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { claimWakeLeases, getResidency, listWakeableMemberIds } from '../store/residency.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { foldBatch } from './fold.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('ledger', (_o, kind) => {
  /**
   * The ledger kind (ADR 365): the wake economy crosses the wire, and decides nothing when it lands.
   *
   * Falsifiers, run between two real daemons:
   *  1. a wake paid for on the joiner is counted by the hub's `report` (the defect this closes);
   *  2. the rows land verbatim in `audit` with the ORIGIN's stamp, projected into nothing;
   *  3. the deciding readers ignore a peer's rows — a seat at its hourly cap on the joiner is still
   *     wakeable on the hub (ADR 365 §3, the residence-2 line);
   *  4. a projected verb wearing the ledger tag stops the fold instead of landing unprojected;
   *  5. a joiner `residency.enrolled` lands on the hub roster as wakeable (ADR 393) — the ledger
   *     still decides nothing: the hub is not the actuator.
   *
   * Harness copied from presence.test.ts so this file stands alone.
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
  const joinerNode = () => readNodeState().nodes['bravo']!.node_id;

  async function roundTrip() {
    await pushTeam(joinerCtx, await joinerTeam());
    await pullTeam(hubCtx(), await hubTeam());
    await pushTeam(hubCtx(), await hubTeam());
    await pullTeam(joinerCtx, await joinerTeam());
  }

  /** Every `audit` row for an action, on one machine. */
  const auditRows = async (db: Database, teamId: string, action: string) =>
    await db.all(
      'SELECT id, target, detail, origin_node, origin_seq FROM audit WHERE team_id = ? AND action = ?',
      [teamId, action],
    );

  /** One wake row as the report path writes it: through `appendAudit`, on the joiner. */
  async function wakeRow(
    action: string,
    seat: string,
    detail: Record<string, unknown>,
    ts?: number,
  ) {
    await appendAudit(joiner.store, (await joinerTeam()).id, {
      actor: null,
      action,
      target: seat,
      result: action === 'residency.wake_failed' ? 'deny' : 'allow',
      detail,
    });
    if (ts !== undefined) {
      await joiner.store.run(
        'UPDATE audit SET ts = ? WHERE team_id = ? AND action = ? AND ts != ?',
        [ts, (await joinerTeam()).id, action, ts],
      );
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-ledger-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

    hub = createServer({ db: await openTestDriver(kind), port: 0 });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({ db: await openTestDriver(kind, { instance: 'b' }), port: 0 });
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
    // Roster identity replicates via git (ADR 058): the same agent seat exists on both.
    await addMember(hub.store, await hubTeam(), { name: 'ada', kind: 'agent' });
    await addMember(joiner.store, await joinerTeam(), { name: 'ada', kind: 'agent' });

    // The joiner's node row is minted on its first logged act; enrollment needs it to exist.
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
      { label: 'joiner laptop' },
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

  describe('the ledger kind — the wake economy crosses, and decides nothing when it lands', async () => {
    it('1. a wake paid for on the joiner is counted by the hub`s report', async () => {
      const now = Date.now();
      await wakeRow('residency.woke', 'ada', { act: 'a-1', lease_id: 'l-1' }, now - 1000);
      await wakeRow(
        'residency.wake_cost',
        'ada',
        { act: 'a-1', lease_id: 'l-1', cost_usd: 0.42 },
        now - 900,
      );

      // Before the fold the hub's ledger is empty — the defect, stated as a precondition.
      expect((await deriveWakeMetrics(hub.store, (await hubTeam()).id, now)).cost_usd_total).toBe(
        null,
      );

      await roundTrip();

      const metrics = await deriveWakeMetrics(hub.store, (await hubTeam()).id, now);
      expect(metrics.cost_usd_total).toBeCloseTo(0.42);
      expect(metrics.cost_reported).toBe(1);
      expect(metrics.by_seat.find((s) => s.seat === 'ada')?.cost_usd_total).toBeCloseTo(0.42);
    });

    it('2. the row lands verbatim with the origin`s stamp, and projects into nothing', async () => {
      await wakeRow('residency.wake_failed', 'ada', { act: 'a-2', reason: 'lease_expired' });
      const mintedOnJoiner = (
        await auditRows(joiner.store, (await joinerTeam()).id, 'residency.wake_failed')
      )[0]!;
      expect(mintedOnJoiner.origin_node).toBe(joinerNode());
      expect(mintedOnJoiner.origin_seq).toBeGreaterThan(0);

      await roundTrip();

      const onHub = await auditRows(hub.store, (await hubTeam()).id, 'residency.wake_failed');
      expect(onHub).toHaveLength(1);
      // The origin's stamp verbatim — never re-minted from the hub's own allocator.
      expect(onHub[0]).toMatchObject({
        id: mintedOnJoiner.id,
        target: 'ada',
        origin_node: joinerNode(),
        origin_seq: mintedOnJoiner.origin_seq,
      });
      expect(JSON.parse(onHub[0]!.detail!)).toMatchObject({ reason: 'lease_expired' });
      // Projected into nothing: no lane, no presence row was invented for it.
      expect(
        (await hub.store.get('SELECT COUNT(*) AS n FROM lanes')) as { n: number },
      ).toMatchObject({
        n: 0,
      });
    });

    it('3. a peer`s wake rows do not decide here — the hourly cap counts what this machine minted', async () => {
      const now = Date.now();
      // Six wakes on the joiner inside the hour: past any default hourly cap, if they counted.
      for (let i = 0; i < 6; i += 1) {
        await wakeRow(
          'residency.woke',
          'ada',
          { act: `cap-${i}`, lease_id: `l-${i}` },
          now - 60_000,
        );
      }
      await roundTrip();
      // The hub HOLDS them — this is not a test that the fold dropped the rows.
      expect(await auditRows(hub.store, (await hubTeam()).id, 'residency.woke')).toHaveLength(6);

      const wakesHere = await hub.store.get(
        `SELECT COUNT(*) AS n FROM audit
          WHERE team_id = ? AND action IN ('residency.woke','residency.wake_failed')
            AND target = ? AND ts > 0
            AND origin_node IN ('', COALESCE((SELECT node_id FROM local_node l WHERE l.team_id = audit.team_id), ''))`,
        [(await hubTeam()).id, 'ada'],
      );
      expect(wakesHere?.n).toBe(0);
    });

    it('4. a projected verb wearing the ledger tag stops the fold', async () => {
      const team = await hubTeam();
      const result = await foldBatch(hub.store, team.id, [
        {
          kind: 'ledger',
          team: 'bravo',
          hub_seq: 1,
          origin_node: 'node-elsewhere',
          origin_seq: 1,
          event: {
            id: 'a-smuggled',
            ts: 1000,
            actor: 'ada',
            action: 'lane.claimed',
            target: 'lane-x',
            result: 'allow',
            detail: { lane: 'lane-x' },
          },
        },
      ]);
      expect(result.stop).toMatchObject({ kind: 'mistagged_ledger_event', action: 'lane.claimed' });
      expect(result.applied).toBe(0);
      expect(await auditRows(hub.store, team.id, 'lane.claimed')).toHaveLength(0);
    });

    it('5. a joiner enrollment lands on the hub roster as wakeable; the hub is not the actuator', async () => {
      const enroll = await post(
        joinerBase,
        '/teams/bravo/residency/enroll',
        { seat: 'ada', harness: 'claude-code', host: 'joiner-host' },
        nickOnJoiner,
      );
      expect(enroll.status).toBe(201);
      const adaOnJoiner = (await getMemberByName(joiner.store, (await joinerTeam()).id, 'ada'))!;
      const adaOnHub = (await getMemberByName(hub.store, (await hubTeam()).id, 'ada'))!;
      expect(
        (await listWakeableMemberIds(joiner.store, (await joinerTeam()).id)).has(adaOnJoiner.id),
      ).toBe(true);
      expect((await listWakeableMemberIds(hub.store, (await hubTeam()).id)).size).toBe(0);

      await roundTrip();

      expect((await listWakeableMemberIds(hub.store, (await hubTeam()).id)).has(adaOnHub.id)).toBe(
        true,
      );
      const folded = await getResidency(hub.store, (await hubTeam()).id, adaOnHub.id);
      expect(folded?.host).toBe('joiner-host');
      expect(folded?.harness).toBe('claude-code');
      expect(folded?.grant_id).toBeNull();
      expect(
        (await getResidency(joiner.store, (await joinerTeam()).id, adaOnJoiner.id))?.grant_id,
      ).not.toBeNull();
      expect(
        await claimWakeLeases(hub.store, (await hubTeam()).id, 'bravo', 'hub-host', 45_000),
      ).toEqual([]);

      const revoked = await post(
        joinerBase,
        '/teams/bravo/residency/revoke',
        { seat: 'ada' },
        nickOnJoiner,
      );
      expect(revoked.status).toBe(200);
      await roundTrip();
      expect((await listWakeableMemberIds(hub.store, (await hubTeam()).id)).size).toBe(0);
      expect(await getResidency(hub.store, (await hubTeam()).id, adaOnHub.id)).toBeNull();
    });
  });
});
