import {
  makeEnvelope,
  summariseDisputes,
  toDisputeRow,
  type RawDisputeRow,
  type Act,
} from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDb } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit } from './audit.js';
import {
  coordinationDensity,
  countLocalWakes,
  countUnpricedWakes,
  deriveReport,
  peerDemand,
  deriveSteeringMetrics,
  deriveDisputes,
  deriveWakeMetrics,
  splitWaitByGate,
  WAKE_GATE_STALE_MS,
  flowMetrics,
  goalFlowMetrics,
  waitingOn,
  wakeCostByDay,
} from './insights.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { enrollResidency } from './residency.js';
import { createTeam, setPolicy } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('insights', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    return { db, team, nick, ada };
  }

  describe('flowMetrics (ADR 050 Part 5, from lane timestamps)', async () => {
    it('counts throughput/WIP and averages cycle time over done lanes', async () => {
      const { db, team } = await seed();
      const now = 10_000_000;
      // A done lane: claimed at now-5m, resolved at now-2m → cycle 3m; done within the week → throughput.
      const done = await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'a', claim: true },
        now - 5 * 60_000,
      );
      await updateLane(db, team.id, done.id, 'revive', { state: 'done' }, now - 2 * 60_000);
      // A live (active) lane → WIP; created 4m ago → oldest_wip_age ~4m.
      const live = await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'b', claim: true },
        now - 4 * 60_000,
      );
      await updateLane(db, team.id, live.id, 'revive', { state: 'active' }, now - 4 * 60_000);

      const f = await flowMetrics(db, team.id, now);
      expect(f.throughput_7d).toBe(1);
      expect(f.cycle_time_ms).toBe(3 * 60_000);
      expect(f.wip).toBe(1);
      expect(f.oldest_wip_age_ms).toBe(4 * 60_000);
    });

    it('is empty-safe: null cycle time and oldest age when nothing qualifies', async () => {
      const { db, team } = await seed();
      const f = await flowMetrics(db, team.id, 1000);
      expect(f).toEqual({
        throughput_7d: 0,
        cycle_time_ms: null,
        wip: 0,
        oldest_wip_age_ms: null,
        backlog: 0,
      });
    });

    it('excludes done lanes older than 7 days from throughput', async () => {
      const { db, team } = await seed();
      const now = 100 * 24 * 60 * 60 * 1000;
      const old = await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'old', claim: true },
        now - 30 * 24 * 60 * 60 * 1000,
      );
      await updateLane(
        db,
        team.id,
        old.id,
        'revive',
        { state: 'done' },
        now - 30 * 24 * 60 * 60 * 1000,
      );
      expect((await flowMetrics(db, team.id, now)).throughput_7d).toBe(0);
    });

    // ADR 295: the engine kept its own SQL literal for the contending set and never followed ADR
    // 169/192 when acceptance became a stage. A lane merged and waiting on a counterpart is in
    // flight — counting it as idle is what made review debt invisible to flow.
    it('counts a lane awaiting acceptance as WIP', async () => {
      const { db, team } = await seed();
      const now = 10_000_000;
      const lane = await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'merged, unaccepted', claim: true },
        now - 6 * 60_000,
      );
      await updateLane(
        db,
        team.id,
        lane.id,
        'revive',
        { state: 'awaiting_acceptance' },
        now - 60_000,
      );

      const f = await flowMetrics(db, team.id, now);
      expect(f.wip).toBe(1);
      expect(f.oldest_wip_age_ms).toBe(6 * 60_000);
    });

    it('reports the backlog — lanes still open, declared and unowned', async () => {
      const { db, team } = await seed();
      const now = 10_000_000;
      await openLane(db, team.id, 'revive', 'ada', { title: 'queued a' }, now - 60_000);
      await openLane(db, team.id, 'revive', 'ada', { title: 'queued b' }, now - 60_000);
      await openLane(db, team.id, 'revive', 'ada', { title: 'taken', claim: true }, now - 60_000);

      expect((await flowMetrics(db, team.id, now)).backlog).toBe(2);
    });
  });

  describe('goalFlowMetrics (ADR 295 — flow dimensioned by Goal)', async () => {
    it('groups the same flow numbers by the goal its lanes name', async () => {
      const { db, team } = await seed();
      const now = 10_000_000;
      // launch: one done lane (cycle 3m) and one live lane created 4m ago.
      const shipped = await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'a', claim: true, goal_id: 'launch' },
        now - 5 * 60_000,
      );
      await updateLane(db, team.id, shipped.id, 'revive', { state: 'done' }, now - 2 * 60_000);
      await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'b', claim: true, goal_id: 'launch' },
        now - 4 * 60_000,
      );
      // research: one queued lane only.
      await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'c', goal_id: 'research' },
        now - 60_000,
      );

      const byGoal = await goalFlowMetrics(db, team.id, now);
      const launch = byGoal.find((g) => g.goal_id === 'launch');
      const research = byGoal.find((g) => g.goal_id === 'research');

      expect(launch?.flow).toEqual({
        throughput_7d: 1,
        cycle_time_ms: 3 * 60_000,
        wip: 1,
        oldest_wip_age_ms: 4 * 60_000,
        backlog: 0,
      });
      expect(research?.flow).toEqual({
        throughput_7d: 0,
        cycle_time_ms: null,
        wip: 0,
        oldest_wip_age_ms: null,
        backlog: 1,
      });
    });

    it('collects goal-less lanes under a null entry, not under a goal', async () => {
      const { db, team } = await seed();
      const now = 10_000_000;
      await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'on a goal', claim: true, goal_id: 'launch' },
        now - 60_000,
      );
      await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'orphan', claim: true },
        now - 2 * 60_000,
      );

      const byGoal = await goalFlowMetrics(db, team.id, now);
      const pool = byGoal.find((g) => g.goal_id === null);
      expect(pool?.flow.wip).toBe(1);
      expect(pool?.flow.oldest_wip_age_ms).toBe(2 * 60_000);
      expect(byGoal.filter((g) => g.goal_id === 'launch')[0]?.flow.wip).toBe(1);
    });

    it('sorts oldest-WIP first, so the dragging goal reads first', async () => {
      const { db, team } = await seed();
      const now = 10_000_000;
      await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'recent', claim: true, goal_id: 'fresh' },
        now - 60_000,
      );
      await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'ancient', claim: true, goal_id: 'dragging' },
        now - 90 * 60_000,
      );

      expect((await goalFlowMetrics(db, team.id, now)).map((g) => g.goal_id)).toEqual([
        'dragging',
        'fresh',
      ]);
    });

    it('says nothing about a goal with no lanes — the roster lives in report.goals', async () => {
      const { db, team } = await seed();
      expect(await goalFlowMetrics(db, team.id, 1000)).toEqual([]);
    });

    it('rides the one projection — deriveReport carries the goal_flow block', async () => {
      const { db, team } = await seed();
      const now = 10_000_000;
      await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'a', claim: true, goal_id: 'launch' },
        now - 60_000,
      );

      const report = await deriveReport(db, team.id, 'revive', now);
      expect(report.goal_flow).toEqual([
        {
          goal_id: 'launch',
          flow: {
            throughput_7d: 0,
            cycle_time_ms: null,
            wip: 1,
            oldest_wip_age_ms: 60_000,
            backlog: 0,
          },
        },
      ]);
    });
  });

  describe('waitingOn (ADR 050 Part 6 — the bottleneck view)', async () => {
    const ask = async (
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      fromId: string,
      toName: string,
      toId: string,
      id: string,
      ts: number,
      thread?: string,
    ) =>
      await insertMessage(
        db,
        teamId,
        fromId,
        toId,
        makeEnvelope({
          id,
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: toName },
          act: 'request_help',
          body: 'need you',
          ts,
          ...(thread ? { thread } : {}),
        }),
      );

    it('aggregates unresolved directed asks by recipient, oldest first', async () => {
      const { db, team, nick, ada } = await seed();
      const now = 40 * 86_400_000;
      // two threads waiting on ada (oldest 3d), one on nick (1d)
      await ask(db, team.id, nick.id, 'ada', ada.id, 'a1', now - 3 * 86_400_000);
      await ask(db, team.id, nick.id, 'ada', ada.id, 'a2', now - 1 * 86_400_000);
      await ask(db, team.id, ada.id, 'nick', nick.id, 'n1', now - 1 * 86_400_000);
      const w = await waitingOn(db, team.id, now);
      expect(w).toEqual([
        { member: 'ada', threads: 2, oldest_age_ms: 3 * 86_400_000 },
        { member: 'nick', threads: 1, oldest_age_ms: 1 * 86_400_000 },
      ]);
    });

    it('a resolve on the thread clears it from the waiting-on view', async () => {
      const { db, team, nick, ada } = await seed();
      const now = 40 * 86_400_000;
      await ask(db, team.id, nick.id, 'ada', ada.id, 'root', now - 86_400_000);
      expect(await waitingOn(db, team.id, now)).toHaveLength(1);
      // ada resolves the thread (root id) → no longer waiting.
      await insertMessage(
        db,
        team.id,
        ada.id,
        null,
        makeEnvelope({
          id: 'res1',
          team: 'revive',
          from: 'ada',
          to: { kind: 'team' },
          act: 'resolve',
          body: 'done',
          thread: 'root',
          ts: now,
        }),
      );
      expect(await waitingOn(db, team.id, now)).toHaveLength(0);
    });

    it('counts a multi-message thread once, dated from its oldest ask', async () => {
      const { db, team, nick, ada } = await seed();
      const now = 40 * 86_400_000;
      await ask(db, team.id, nick.id, 'ada', ada.id, 'root', now - 2 * 86_400_000);
      await ask(db, team.id, nick.id, 'ada', ada.id, 'followup', now - 1 * 86_400_000, 'root');
      const w = await waitingOn(db, team.id, now);
      expect(w).toEqual([{ member: 'ada', threads: 1, oldest_age_ms: 2 * 86_400_000 }]);
    });

    // ADR 590 (lane 01M4VZ5Y31): the view used to count every directed act until a resolve, so the
    // revive hub reported 7,730 open threads — every accept and status_update anyone was sent.
    const send = async (
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      from: { id: string; name: string },
      to: { id: string; name: string },
      id: string,
      act: Act,
      ts: number,
      meta?: Record<string, unknown>,
    ) =>
      await insertMessage(
        db,
        teamId,
        from.id,
        to.id,
        makeEnvelope({
          id,
          team: 'revive',
          from: from.name,
          to: { kind: 'member', name: to.name },
          act,
          body: 'x',
          ts,
          ...(meta ? { meta } : {}),
        }),
      );

    it('an act that asks nothing of its recipient is not owed (ADR 590)', async () => {
      const { db, team, nick, ada } = await seed();
      const now = 40 * 86_400_000;
      await send(db, team.id, nick, ada, 'm1', 'message', now - 86_400_000);
      await send(db, team.id, nick, ada, 'm2', 'status_update', now - 86_400_000);
      await send(db, team.id, nick, ada, 'm3', 'accept', now - 86_400_000, { in_reply_to: 'zz' });
      expect(await waitingOn(db, team.id, now)).toEqual([]);
      // …unless the sender flagged it urgent.
      await send(db, team.id, nick, ada, 'm4', 'message', now - 86_400_000, {
        urgent: true,
        urgent_reason: 'blocking the release',
      });
      expect(await waitingOn(db, team.id, now)).toEqual([
        { member: 'ada', threads: 1, oldest_age_ms: 86_400_000 },
      ]);
    });

    it("the recipient's own reply discharges an owed act, like every other reader (ADR 434)", async () => {
      const { db, team, nick, ada } = await seed();
      const now = 40 * 86_400_000;
      await ask(db, team.id, nick.id, 'ada', ada.id, 'q1', now - 86_400_000);
      await send(db, team.id, ada, nick, 'r1', 'message', now - 1_000, { in_reply_to: 'q1' });
      expect(await waitingOn(db, team.id, now)).toEqual([]);
    });

    it('a handoff whose lane has left play is discharged', async () => {
      const { db, team, nick, ada } = await seed();
      const now = 40 * 86_400_000;
      const lane = await openLane(db, team.id, 'revive', 'ada', { title: 'l', claim: true }, 1);
      await send(db, team.id, nick, ada, 'h1', 'handoff', now - 86_400_000, {
        lane_handoff: { lane: lane.id },
      });
      expect(await waitingOn(db, team.id, now)).toHaveLength(1);
      await updateLane(db, team.id, lane.id, 'revive', { state: 'done' }, 2);
      expect(await waitingOn(db, team.id, now)).toEqual([]);
    });
  });

  describe("peerDemand (ADR 320 §5b, read from the human's side)", async () => {
    const NOW = 40 * 86_400_000;
    let n = 0;
    const post = async (
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      from: { id: string; name: string },
      act: Act,
      to: { kind: 'team' } | { kind: 'member'; name: string; id: string },
      meta?: Record<string, unknown>,
    ) => {
      const id = `p${n++}`;
      await insertMessage(
        db,
        teamId,
        from.id,
        to.kind === 'member' ? to.id : null,
        makeEnvelope({
          id,
          team: 'revive',
          from: from.name,
          to: to.kind === 'member' ? { kind: 'member', name: to.name } : { kind: 'team' },
          act,
          body: 'x',
          ts: NOW - 1000,
          ...(meta ? { meta } : {}),
        }),
      );
      return id;
    };

    it('counts challenges by recipient kind and keeps team-addressed ones apart', async () => {
      const { db, team, nick, ada } = await seed();
      const bob = (await addMember(db, team, { name: 'bob', kind: 'agent' })).row;
      const svc = (await addMember(db, team, { name: 'guardian', kind: 'service' })).row;
      await post(db, team.id, ada, 'challenge', { kind: 'member', name: 'nick', id: nick.id });
      await post(db, team.id, nick, 'challenge', { kind: 'member', name: 'ada', id: ada.id });
      await post(db, team.id, bob, 'challenge', { kind: 'member', name: 'ada', id: ada.id });
      await post(db, team.id, ada, 'challenge', { kind: 'team' });
      // A service seat is a member with its own kind — never folded into `agent`.
      await post(db, team.id, ada, 'challenge', { kind: 'member', name: 'guardian', id: svc.id });
      const p = await peerDemand(db, team.id, NOW);
      expect(p.challenges).toEqual({ to_human: 1, to_agent: 2, to_service: 1, unaddressed: 1 });
    });

    it("counts declines of handoffs by the handoff SENDER's kind, and ignores declines of asks", async () => {
      const { db, team, nick, ada } = await seed();
      const h1 = await post(db, team.id, nick, 'handoff', {
        kind: 'member',
        name: 'ada',
        id: ada.id,
      });
      await post(
        db,
        team.id,
        ada,
        'decline',
        { kind: 'member', name: 'nick', id: nick.id },
        { in_reply_to: h1 },
      );
      const h2 = await post(db, team.id, ada, 'handoff', {
        kind: 'member',
        name: 'nick',
        id: nick.id,
      });
      await post(
        db,
        team.id,
        nick,
        'decline',
        { kind: 'member', name: 'ada', id: ada.id },
        { in_reply_to: h2 },
      );
      const a1 = await post(db, team.id, ada, 'request_help', {
        kind: 'member',
        name: 'nick',
        id: nick.id,
      });
      await post(
        db,
        team.id,
        nick,
        'decline',
        { kind: 'member', name: 'ada', id: ada.id },
        { in_reply_to: a1 },
      );
      const p = await peerDemand(db, team.id, NOW);
      expect(p.handoff_declines).toEqual({ of_human: 1, of_agent: 1, of_service: 0 });
    });

    it('lists every human with their act and accept counts, zero when quiet', async () => {
      const { db, team, nick, ada } = await seed();
      const lin = (await addMember(db, team, { name: 'lin', kind: 'human' })).row;
      const r1 = await post(db, team.id, ada, 'request_help', {
        kind: 'member',
        name: 'nick',
        id: nick.id,
      });
      await post(
        db,
        team.id,
        nick,
        'accept',
        { kind: 'member', name: 'ada', id: ada.id },
        { in_reply_to: r1 },
      );
      await post(db, team.id, nick, 'status_update', { kind: 'team' });
      await post(db, team.id, nick, 'challenge', { kind: 'member', name: 'ada', id: ada.id });
      const p = await peerDemand(db, team.id, NOW);
      expect(p.humans).toEqual([
        { name: 'lin', acts: 0, accepts: 0 },
        { name: 'nick', acts: 3, accepts: 1 },
      ]);
      expect(lin.kind).toBe('human');
    });

    it('flags the falsifier baseline only on a real sample: humans present, ≥ min acts, zero of both', async () => {
      const { db, team, nick, ada } = await seed();
      for (let i = 0; i < 12; i++) await post(db, team.id, ada, 'status_update', { kind: 'team' });
      expect((await peerDemand(db, team.id, NOW)).flag).toBe(true);
      // One challenge to a human clears it.
      await post(db, team.id, ada, 'challenge', { kind: 'member', name: 'nick', id: nick.id });
      expect((await peerDemand(db, team.id, NOW)).flag).toBe(false);
    });

    it('does not flag a tiny sample, and is empty-safe', async () => {
      const { db, team, ada } = await seed();
      expect(await peerDemand(db, team.id, NOW)).toMatchObject({
        challenges: { to_human: 0, to_agent: 0, to_service: 0, unaddressed: 0 },
        handoff_declines: { of_human: 0, of_agent: 0, of_service: 0 },
        flag: false,
      });
      for (let i = 0; i < 3; i++) await post(db, team.id, ada, 'status_update', { kind: 'team' });
      expect((await peerDemand(db, team.id, NOW)).flag).toBe(false);
    });

    it('is on the derived report', async () => {
      const { db, team } = await seed();
      expect((await deriveReport(db, team.id, team.slug, NOW)).peer_demand.window_days).toBe(7);
    });
  });

  describe('coordinationDensity (the P3 broadcast-journal signal)', async () => {
    const NOW = 40 * 86_400_000;
    let n = 0;
    const post = async (
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      fromId: string,
      act: Act,
      to: { kind: 'team' } | { kind: 'member'; name: string; id: string },
      thread?: string,
    ) =>
      await insertMessage(
        db,
        teamId,
        fromId,
        to.kind === 'member' ? to.id : null,
        makeEnvelope({
          id: `c${n++}`,
          team: 'revive',
          from: 'nick',
          to: to.kind === 'member' ? { kind: 'member', name: to.name } : { kind: 'team' },
          act,
          body: 'x',
          ts: NOW - 1000,
          ...(thread ? { thread } : {}),
        }),
      );

    it('flags a journal-heavy, exchange-light window', async () => {
      const { db, team, nick } = await seed();
      // 12 broadcast status_updates, no directed/threaded exchange → journal 100%, exchange 0%.
      for (let i = 0; i < 12; i++)
        await post(db, team.id, nick.id, 'status_update', { kind: 'team' });
      const c = await coordinationDensity(db, team.id, NOW);
      expect(c.acts).toBe(12);
      expect(c.journal).toBe(12);
      expect(c.journal_ratio).toBe(1);
      expect(c.exchange_ratio).toBe(0);
      expect(c.flag).toBe(true);
    });

    it('does not flag when there is healthy directed + threaded exchange', async () => {
      const { db, team, nick, ada } = await seed();
      for (let i = 0; i < 6; i++)
        await post(db, team.id, nick.id, 'status_update', { kind: 'team' });
      // 6 directed request_help → exchange 50%.
      for (let i = 0; i < 6; i++)
        await post(db, team.id, nick.id, 'request_help', {
          kind: 'member',
          name: 'ada',
          id: ada.id,
        });
      const c = await coordinationDensity(db, team.id, NOW);
      expect(c.directed).toBe(6);
      expect(c.exchange_ratio).toBe(0.5);
      expect(c.flag).toBe(false);
    });

    it('does not flag a tiny sample below the minimum, even if all journal', async () => {
      const { db, team, nick } = await seed();
      for (let i = 0; i < 3; i++)
        await post(db, team.id, nick.id, 'status_update', { kind: 'team' });
      const c = await coordinationDensity(db, team.id, NOW);
      expect(c.journal_ratio).toBe(1);
      expect(c.flag).toBe(false); // 3 < COORD_MIN_ACTS
    });

    it('is empty-safe: zero ratios, no flag, no NaN', async () => {
      const { db, team } = await seed();
      const c = await coordinationDensity(db, team.id, NOW);
      expect(c).toMatchObject({ acts: 0, journal_ratio: 0, exchange_ratio: 0, flag: false });
    });
  });

  describe('deriveSteeringMetrics (ADR 125 — interrupt-line arc metrics)', async () => {
    const NOW = 40 * 86_400_000;

    it('is empty-safe: zeros and null latencies', async () => {
      const { db, team } = await seed();
      expect(await deriveSteeringMetrics(db, team.id, NOW)).toEqual({
        window_days: 7,
        steers: 0,
        acked: 0,
        latency_median_ms: null,
        latency_p95_ms: null,
        superseded_acts: 0,
        stale_wakes: 0,
        stale_caught: 0,
      });
    });

    it('measures steer→ack latency from the recipient’s next act', async () => {
      const { db, team, nick, ada } = await seed();
      // nick steers ada; ada’s next status_update 2m later is the ack.
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 'steer1',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'steer',
          body: 'use v2',
          ts: NOW - 5 * 60_000,
        }),
      );
      await insertMessage(
        db,
        team.id,
        ada.id,
        null,
        makeEnvelope({
          id: 'ack1',
          team: 'revive',
          from: 'ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 'switching to v2',
          ts: NOW - 3 * 60_000,
        }),
      );
      const s = await deriveSteeringMetrics(db, team.id, NOW);
      expect(s.steers).toBe(1);
      expect(s.acked).toBe(1);
      expect(s.latency_median_ms).toBe(2 * 60_000);
      expect(s.latency_p95_ms).toBe(2 * 60_000);
    });

    it('counts an unacked steer without inventing a latency', async () => {
      const { db, team, nick, ada } = await seed();
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 'steer-open',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'steer',
          body: 'stop',
          ts: NOW - 60_000,
        }),
      );
      const s = await deriveSteeringMetrics(db, team.id, NOW);
      expect(s.steers).toBe(1);
      expect(s.acked).toBe(0);
      expect(s.latency_median_ms).toBeNull();
    });

    it('counts acts that reply to a superseded steer', async () => {
      const { db, team, nick, ada } = await seed();
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 's-old',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'steer',
          body: 'do A',
          ts: NOW - 10 * 60_000,
        }),
      );
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 's-new',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'steer',
          body: 'do B instead',
          ts: NOW - 5 * 60_000,
        }),
      );
      // ada accepts the OLD steer after the new one landed — contradictory-stack failure.
      await insertMessage(
        db,
        team.id,
        ada.id,
        nick.id,
        makeEnvelope({
          id: 'bad-ack',
          team: 'revive',
          from: 'ada',
          to: { kind: 'member', name: 'nick' },
          act: 'accept',
          body: 'doing A',
          ts: NOW - 4 * 60_000,
          meta: { in_reply_to: 's-old' },
        }),
      );
      expect((await deriveSteeringMetrics(db, team.id, NOW)).superseded_acts).toBe(1);
    });

    it('counts a same-ts superseded steer via id tie-break (ADR 103 / Bugbot #216)', async () => {
      const { db, team, nick, ada } = await seed();
      const ts = NOW - 5 * 60_000;
      // Two steers in the same millisecond — higher id wins (ULID order), matching pendingInterrupts.
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 's-a',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'steer',
          body: 'do A',
          ts,
        }),
      );
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 's-b',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'steer',
          body: 'do B instead',
          ts,
        }),
      );
      await insertMessage(
        db,
        team.id,
        ada.id,
        nick.id,
        makeEnvelope({
          id: 'bad-same-ts',
          team: 'revive',
          from: 'ada',
          to: { kind: 'member', name: 'nick' },
          act: 'accept',
          body: 'doing A',
          ts: ts + 1000,
          meta: { in_reply_to: 's-a' },
        }),
      );
      expect((await deriveSteeringMetrics(db, team.id, NOW)).superseded_acts).toBe(1);
    });

    it('counts a stale wake as caught when the subject lane is later abandoned', async () => {
      const { db, team, nick, ada } = await seed();
      const lane = await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'stale work', claim: true },
        NOW - 20 * 60_000,
      );
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 'wake1',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'message',
          body: '[lane] plan moved',
          ts: NOW - 10 * 60_000,
          meta: {
            lane_warning: {
              kind: 'stale_plan',
              subject: lane.id,
              with: 'goal-x',
              owner: 'ada',
              detail: 'plan moved',
            },
          },
        }),
      );
      await updateLane(db, team.id, lane.id, 'revive', { state: 'abandoned' }, NOW - 5 * 60_000);
      const s = await deriveSteeringMetrics(db, team.id, NOW);
      expect(s.stale_wakes).toBe(1);
      expect(s.stale_caught).toBe(1);
    });

    it('does not count a stale wake as caught when the lane stays live untouched', async () => {
      const { db, team, nick, ada } = await seed();
      const lane = await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'still building', claim: true },
        NOW - 20 * 60_000,
      );
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 'wake2',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'message',
          body: '[lane] dep moved',
          ts: NOW - 10 * 60_000,
          meta: {
            lane_warning: {
              kind: 'stale_dependency',
              subject: lane.id,
              with: 'other-lane',
              owner: 'ada',
              detail: 'dep moved',
            },
          },
        }),
      );
      const s = await deriveSteeringMetrics(db, team.id, NOW);
      expect(s.stale_wakes).toBe(1);
      expect(s.stale_caught).toBe(0);
    });

    it('does not count an unrelated owner status_update as catching a stale wake (ADR 126)', async () => {
      const { db, team, nick, ada } = await seed();
      const lane = await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'warned work', claim: true, goal_id: 'goal-x' },
        NOW - 20 * 60_000,
      );
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 'wake-unrelated',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'message',
          body: '[lane] plan moved',
          ts: NOW - 10 * 60_000,
          meta: {
            lane_warning: {
              kind: 'stale_plan',
              subject: lane.id,
              with: 'goal-x',
              owner: 'ada',
              detail: 'plan moved',
            },
          },
        }),
      );
      // Routine journal about other work — must NOT count as caught.
      await insertMessage(
        db,
        team.id,
        ada.id,
        null,
        makeEnvelope({
          id: 'other-work',
          team: 'revive',
          from: 'ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 'working on something else',
          ts: NOW - 5 * 60_000,
        }),
      );
      const s = await deriveSteeringMetrics(db, team.id, NOW);
      expect(s.stale_wakes).toBe(1);
      expect(s.stale_caught).toBe(0);
    });

    it('counts a wake as caught when the owner replies to it or names its goal (ADR 126)', async () => {
      const { db, team, nick, ada } = await seed();
      const lane = await openLane(
        db,
        team.id,
        'revive',
        'ada',
        { title: 'warned work', claim: true, goal_id: 'goal-x' },
        NOW - 20 * 60_000,
      );
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 'wake-scoped',
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'message',
          body: '[lane] plan moved',
          ts: NOW - 10 * 60_000,
          meta: {
            lane_warning: {
              kind: 'stale_plan',
              subject: lane.id,
              with: 'goal-x',
              owner: 'ada',
              detail: 'plan moved',
            },
          },
        }),
      );
      await insertMessage(
        db,
        team.id,
        ada.id,
        null,
        makeEnvelope({
          id: 'recheck',
          team: 'revive',
          from: 'ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 're-checking direction on goal-x',
          ts: NOW - 5 * 60_000,
          meta: { goal_id: 'goal-x' },
        }),
      );
      expect((await deriveSteeringMetrics(db, team.id, NOW)).stale_caught).toBe(1);
    });
  });

  describe('deriveWakeMetrics (ADR 131 inc 5) — latency, answer rate, cost, budgets', async () => {
    const NOW = 10_000_000_000;

    async function wakeSeed() {
      const { db, team, nick, ada } = await seed();
      await enrollResidency(db, team.id, {
        member_id: ada.id,
        harness: 'claude-code',
        host: 'mac.lan',
        grant_id: 'g1',
        authorized_by: 'nick',
      });
      return { db, team, nick, ada };
    }

    /** A residency audit row with detail + a backdated ts (appendAudit stamps now). */
    async function residencyRow(
      db: ReturnType<typeof openDb>,
      teamId: string,
      action:
        | 'residency.woke'
        | 'residency.wake_failed'
        | 'residency.wake_deferred'
        | 'residency.wake_exhausted'
        | 'residency.wake_cost'
        | 'residency.wake_leased'
        | 'residency.wake_gate',
      seat: string,
      detail: Record<string, unknown>,
      ts: number,
    ) {
      await appendAudit(db, teamId, {
        actor: null,
        action,
        target: seat,
        result:
          action === 'residency.woke' ||
          action === 'residency.wake_cost' ||
          action === 'residency.wake_leased'
            ? 'allow'
            : 'deny',
        detail,
      });
      await db.run(
        'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
        [ts],
      );
    }

    async function directed(
      db: ReturnType<typeof openDb>,
      team: { id: string; slug?: string },
      from: { id: string; name: string },
      to: { id: string; name: string },
      act: Act,
      id: string,
      ts: number,
      meta: Record<string, unknown> | null = null,
    ) {
      await insertMessage(
        db,
        team.id,
        from.id,
        to.id,
        makeEnvelope({
          id,
          team: 'revive',
          from: from.name,
          to: { kind: 'member', name: to.name },
          act,
          body: 'x',
          ts,
          meta,
        }),
      );
    }

    it('empty window ⇒ zero counts and nulls, never NaN', async () => {
      const { db, team } = await wakeSeed();
      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k).toMatchObject({
        wakes: 0,
        resumed: 0,
        failed: 0,
        deferred: 0,
        exhausted: 0,
        answered: 0,
        answer_rate: null,
        latency_median_ms: null,
        cost_usd_total: null,
        cost_usd_per_wake: null,
        cost_reported: 0,
        by_seat: [],
      });
      expect(k).not.toHaveProperty('spend_cap_usd');
      expect(k).not.toHaveProperty('spend_over_cap');
    });

    it('latency = trigger ts → seat first act; attempts dedupe to one sample per act', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
      // Two woke rows for the SAME act (a retry) — one latency sample, classified by the last row.
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h1', lease_id: 'L1' },
        NOW - 50 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h1', lease_id: 'L2', session: 'resumed' },
        NOW - 40 * 60_000,
      );
      // ada's first act after the trigger: 5 minutes later.
      await directed(db, team, ada, nick, 'accept', 'a1', NOW - 55 * 60_000, { in_reply_to: 'h1' });

      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.wakes).toBe(1);
      expect(k.resumed).toBe(1);
      expect(k.latency_median_ms).toBe(5 * 60_000);
      expect(k.answered).toBe(1); // the accept names h1 in the LIVE ledger
      expect(k.answer_rate).toBe(1);
    });

    it('answer rate reads the ledger live, not the report-time snapshot', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
      // The host reported answered:false at verify time (honest but stale)…
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h1', lease_id: 'L1', answered: false },
        NOW - 50 * 60_000,
      );
      const before = await deriveWakeMetrics(db, team.id, NOW);
      expect(before.answered).toBe(0);
      // …then the woken session answered AFTER the report settled — the metric must see it.
      await directed(db, team, ada, nick, 'accept', 'a1', NOW - 30 * 60_000, { in_reply_to: 'h1' });
      const after = await deriveWakeMetrics(db, team.id, NOW);
      expect(after.answered).toBe(1);
    });

    it('cost dedupes by lease, preferring the supplementary wake_cost row; counters count', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
      await directed(db, team, nick, ada, 'steer', 's2', NOW - 59 * 60_000);
      // Wake 1: primary report carried a (stale, partial) cost; the supplement corrects it.
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h1', lease_id: 'L1', cost_usd: 0.1 },
        NOW - 50 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_cost',
        'ada',
        { act: 'h1', lease_id: 'L1', cost_usd: 0.9, duration_ms: 30_000 },
        NOW - 49 * 60_000,
      );
      // Wake 2: no cost ever reported (crash) — the honesty denominator must show 1 of 2.
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 's2', lease_id: 'L2' },
        NOW - 45 * 60_000,
      );
      // Quiet counters.
      await residencyRow(
        db,
        team.id,
        'residency.wake_failed',
        'ada',
        { act: 's2', lease_id: 'L3' },
        NOW - 44 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_deferred',
        'ada',
        { act: 's2', lease_id: 'L4' },
        NOW - 43 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_exhausted',
        'ada',
        { act: 'h0' },
        NOW - 42 * 60_000,
      );

      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.wakes).toBe(2);
      expect(k.failed).toBe(1);
      expect(k.deferred).toBe(1);
      expect(k.exhausted).toBe(1);
      expect(k.cost_usd_total).toBeCloseTo(0.9); // L1 deduped to the supplement, L2 costless
      expect(k.cost_reported).toBe(1);
      expect(k.cost_usd_per_wake).toBeCloseTo(0.9);
    });

    // ADR 252: cost only ever arrives on the report path, so a lease that spawned a session and then
    // expired unreported reads as free. The session's attested lease token is what makes that spend
    // sayable — as a COUNT, never as an invented dollar figure folded into the totals.
    it('counts a lease that paid for a session and reported no cost as unpriced, not as free', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
      // A wake that spawned a session and then died on its lease: the expiry row carries the fact.
      await residencyRow(
        db,
        team.id,
        'residency.wake_failed',
        'ada',
        { act: 'h1', lease_id: 'L1', reason: 'lease_expired', session_captured: true },
        NOW - 50 * 60_000,
      );
      // A second wake that also spawned a session but DID report its cost — priced, so not counted.
      await residencyRow(
        db,
        team.id,
        'residency.wake_failed',
        'ada',
        { act: 'h1', lease_id: 'L2', reason: 'lease_expired', session_captured: true },
        NOW - 49 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_cost',
        'ada',
        { act: 'h1', lease_id: 'L2', cost_usd: 0.4 },
        NOW - 48 * 60_000,
      );
      // A third expiry with no session evidence at all stays silent — absence is not a zero.
      await residencyRow(
        db,
        team.id,
        'residency.wake_failed',
        'ada',
        { act: 'h1', lease_id: 'L3', reason: 'lease_expired' },
        NOW - 47 * 60_000,
      );

      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.unpriced_sessions).toBe(1);
      // The totals are untouched: the unpriced wake contributes no fabricated spend.
      expect(k.cost_usd_total).toBeCloseTo(0.4);
      expect(k.cost_reported).toBe(1);
    });

    it('by_seat flags over_budget against the effective budget_usd (a per-run report bound)', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      // Seat override: budget $0.50 per wake.
      await enrollResidency(db, team.id, {
        member_id: ada.id,
        harness: 'claude-code',
        host: 'mac.lan',
        grant_id: 'g1',
        authorized_by: 'nick',
        policy: { budget_usd: 0.5 },
      });
      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h1', lease_id: 'L1', cost_usd: 0.8 },
        NOW - 50 * 60_000,
      );
      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.by_seat).toEqual([
        {
          seat: 'ada',
          wakes: 1,
          cost_usd_total: 0.8,
          budget_usd: 0.5,
          over_budget: true,
          by_day: [
            {
              day: new Date(NOW - 50 * 60_000).toISOString().slice(0, 10),
              priced: 1,
              cost_usd_total: 0.8,
            },
          ],
        },
      ]);
    });

    it('by_day splits a seat’s priced leases by the UTC day the price arrived (ADR 748)', () => {
      const day = Date.UTC(2026, 9, 27);
      expect(
        wakeCostByDay([
          { cost: 6.1, ts: day + 23 * 3_600_000 },
          { cost: 0.5, ts: day - 1 },
          { cost: 6.2, ts: day + 3_600_000 },
        ]),
      ).toEqual([
        { day: '2026-10-26', priced: 1, cost_usd_total: 0.5 },
        { day: '2026-10-27', priced: 2, cost_usd_total: expect.closeTo(12.3) as number },
      ]);
      expect(wakeCostByDay([])).toEqual([]);
    });

    it('waited_ms is each act’s first lease minus its ts, message acts only (ADR 749)', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
      await directed(db, team, nick, ada, 'request_help', 'h2', NOW - 30 * 60_000);
      // h1: leased at +5 min, re-leased at +20 min — the first lease is the wait.
      await residencyRow(
        db,
        team.id,
        'residency.wake_leased',
        'ada',
        { act: 'h1', lease_id: 'L1' },
        NOW - 55 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_leased',
        'ada',
        { act: 'h1', lease_id: 'L2' },
        NOW - 40 * 60_000,
      );
      // h2: leased at +1 min, never woken.
      await residencyRow(
        db,
        team.id,
        'residency.wake_leased',
        'ada',
        { act: 'h2', lease_id: 'L3' },
        NOW - 29 * 60_000,
      );
      // A dream lease has no message: skipped.
      await residencyRow(
        db,
        team.id,
        'residency.wake_leased',
        'ada',
        { act: 'dream', lease_id: 'L4' },
        NOW - 10 * 60_000,
      );
      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.by_seat).toHaveLength(1);
      expect(k.by_seat[0]).toMatchObject({
        seat: 'ada',
        wakes: 0,
        waited_ms: [60_000, 5 * 60_000],
      });
    });

    it('holds split each wait by the gate rows in force (ADR 753)', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
      await residencyRow(
        db,
        team.id,
        'residency.wake_gate',
        'ada',
        { state: 'present' },
        NOW - 90 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_gate',
        'ada',
        { state: 'snoozed' },
        NOW - 40 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_gate',
        'ada',
        { state: 'passed' },
        NOW - 10 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_leased',
        'ada',
        { act: 'h1', lease_id: 'L1' },
        NOW - 5 * 60_000,
      );
      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.by_seat[0]).toMatchObject({
        seat: 'ada',
        waited_ms: [55 * 60_000],
        holds: [
          {
            waited_ms: 55 * 60_000,
            by_state: { present: 20 * 60_000, snoozed: 30 * 60_000, passed: 5 * 60_000 },
          },
        ],
      });
    });

    it('splitWaitByGate: a gap past the keepalive and time before any row are unobserved', () => {
      const rows = [
        { ts: 0, state: 'present' as const },
        { ts: 200 * 60_000, state: 'passed' as const },
      ];
      // 0 → 75 min present, 75 → 200 min no row, 200 → 210 min passed.
      expect(splitWaitByGate(rows, 0, 210 * 60_000)).toEqual({
        present: WAKE_GATE_STALE_MS,
        unobserved: 200 * 60_000 - WAKE_GATE_STALE_MS,
        passed: 10 * 60_000,
      });
      // A wait that starts before the seat's first row.
      expect(splitWaitByGate(rows.slice(1), 190 * 60_000, 210 * 60_000)).toEqual({
        unobserved: 10 * 60_000,
        passed: 10 * 60_000,
      });
      // No rows at all.
      expect(splitWaitByGate([], 0, 1000)).toEqual({ unobserved: 1000 });
    });

    it('by_day counts a lease once, on its wake_cost row’s day', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 30 * 60 * 60_000);
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h1', lease_id: 'L1', cost_usd: 0.1 },
        NOW - 30 * 60 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_cost',
        'ada',
        { act: 'h1', lease_id: 'L1', cost_usd: 0.9 },
        NOW - 60_000,
      );
      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.by_seat[0]?.by_day).toEqual([
        { day: new Date(NOW - 60_000).toISOString().slice(0, 10), priced: 1, cost_usd_total: 0.9 },
      ]);
    });

    it('window excludes older rows; deriveReport carries the wake block', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 10 * 24 * 60 * 60_000);
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h1', lease_id: 'L1' },
        NOW - 9 * 24 * 60 * 60_000, // 9 days ago — outside the 7d window
      );
      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.wakes).toBe(0);
      const report = await deriveReport(db, team.id, 'revive', NOW);
      expect(report.wake).toBeDefined();
      expect(report.wake!.window_days).toBe(7);
    });

    it('deriveReport carries the spend cap only when set, and warns at the priced total (ADR 602)', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      const unset = await deriveReport(db, team.id, 'revive', NOW);
      expect(unset.wake).not.toHaveProperty('spend_cap_usd');
      expect(unset.wake).not.toHaveProperty('spend_over_cap');

      await setPolicy(db, team.id, { spend_cap_usd: 10 });
      const quiet = await deriveReport(db, team.id, 'revive', NOW);
      expect(quiet.wake?.spend_cap_usd).toBe(10);
      expect(quiet.wake?.spend_over_cap).toBe(false);
      // The metric function stays free of the cap, so its callers do not grow a field.
      expect(await deriveWakeMetrics(db, team.id, NOW)).not.toHaveProperty('spend_cap_usd');

      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h1', lease_id: 'L1', cost_usd: 10 },
        NOW - 50 * 60_000,
      );
      const atCap = await deriveReport(db, team.id, 'revive', NOW);
      expect(atCap.wake?.cost_usd_total).toBeCloseTo(10);
      expect(atCap.wake?.spend_over_cap).toBe(true);

      await setPolicy(db, team.id, { spend_cap_usd: 10.01 });
      const under = await deriveReport(db, team.id, 'revive', NOW);
      expect(under.wake?.spend_cap_usd).toBe(10.01);
      expect(under.wake?.spend_over_cap).toBe(false);
    });

    it('deriveReport copies the per-wake approval threshold only when set (ADR 635)', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      const unset = await deriveReport(db, team.id, 'revive', NOW);
      expect(unset.wake).not.toHaveProperty('spend_approval_usd');

      await setPolicy(db, team.id, { spend_approval_usd: 12.5 });
      const quiet = await deriveReport(db, team.id, 'revive', NOW);
      expect(quiet.wake?.spend_approval_usd).toBe(12.5);
      // The weekly cap is a different comparison. This key does not invent spend_over_cap.
      expect(quiet.wake).not.toHaveProperty('spend_over_cap');
      expect(await deriveWakeMetrics(db, team.id, NOW)).not.toHaveProperty('spend_approval_usd');

      await directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h1', lease_id: 'L1', cost_usd: 40 },
        NOW - 50 * 60_000,
      );
      const priced = await deriveReport(db, team.id, 'revive', NOW);
      expect(priced.wake?.cost_usd_total).toBeCloseTo(40);
      expect(priced.wake?.spend_approval_usd).toBe(12.5);
      expect(priced.wake).not.toHaveProperty('spend_over_cap');

      await setPolicy(db, team.id, { spend_approval_usd: 12.5, spend_cap_usd: 50 });
      const withCap = await deriveReport(db, team.id, 'revive', NOW);
      expect(withCap.wake?.spend_approval_usd).toBe(12.5);
      expect(withCap.wake?.spend_cap_usd).toBe(50);
      expect(withCap.wake?.spend_over_cap).toBe(false);
    });

    it('counts a settled unpriced lease once, and a positive cost drops it (ADR 639)', () => {
      expect(
        countUnpricedWakes([
          {
            action: 'residency.wake_failed',
            detail: { lease_id: 'L1', session_captured: true },
          },
          {
            action: 'residency.wake_failed',
            detail: { lease_id: 'L2', session_captured: true },
          },
          { action: 'residency.wake_cost', detail: { lease_id: 'L2', cost_usd: 0.4 } },
          { action: 'residency.wake_failed', detail: { lease_id: 'L3' } },
          { action: 'residency.wake_cost', detail: { lease_id: 'Lz', cost_usd: 0 } },
          { action: 'residency.woke', detail: { lease_id: 'Lflight' } },
          { action: 'residency.wake_deferred', detail: { lease_id: 'Ldef' } },
          { action: 'residency.wake_exhausted', detail: {} },
          { action: 'residency.wake_report_rejected', detail: { lease_id: 'Lrej' } },
          { action: 'residency.woke', detail: { lease_id: 'Lwoke', cost_usd: 0 } },
          { action: 'residency.wake_cost', detail: { lease_id: 'Lmix', cost_usd: 0 } },
          { action: 'residency.wake_cost', detail: { lease_id: 'Lmix', cost_usd: 1 } },
        ]),
      ).toBe(5);
    });

    it('a `local` wake is counted once as local and still counted as unpriced (ADR 663)', () => {
      const rows = [
        { action: 'residency.woke', detail: { lease_id: 'La' } },
        {
          action: 'residency.wake_cost',
          detail: { lease_id: 'La', unpriced_reason: 'local', duration_ms: 1 },
        },
        { action: 'residency.wake_cost', detail: { lease_id: 'La', unpriced_reason: 'local' } },
        {
          action: 'residency.wake_cost',
          detail: { lease_id: 'Lb', unpriced_reason: 'harness_price_unverified' },
        },
        { action: 'residency.wake_failed', detail: { lease_id: 'Lc', unpriced_reason: 'local' } },
      ];
      expect(countLocalWakes(rows)).toBe(1);
      // The cap still sees it: a claim names a wake, it never switches a spend guard off.
      expect(countUnpricedWakes(rows)).toBe(3);
    });

    it('deriveReport carries the unpriced count only when the cap is set (ADR 639)', async () => {
      const { db, team } = await wakeSeed();
      const unset = await deriveReport(db, team.id, 'revive', NOW);
      expect(unset.wake).not.toHaveProperty('unpriced_wake_cap');
      expect(unset.wake).not.toHaveProperty('unpriced_wake_count');
      expect(unset.wake).not.toHaveProperty('unpriced_over_cap');

      await setPolicy(db, team.id, { unpriced_wake_cap: 0 });
      const quiet = await deriveReport(db, team.id, 'revive', NOW);
      expect(quiet.wake?.unpriced_wake_cap).toBe(0);
      expect(quiet.wake?.unpriced_wake_count).toBe(0);
      expect(quiet.wake?.unpriced_over_cap).toBe(true);
      expect(await deriveWakeMetrics(db, team.id, NOW)).not.toHaveProperty('unpriced_wake_cap');

      await residencyRow(
        db,
        team.id,
        'residency.wake_failed',
        'ada',
        { act: 'h1', lease_id: 'L1', reason: 'lease_expired', session_captured: true },
        NOW - 50 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_failed',
        'ada',
        { act: 'h1', lease_id: 'L2', reason: 'lease_expired', session_captured: true },
        NOW - 49 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_cost',
        'ada',
        { act: 'h1', lease_id: 'L2', cost_usd: 0.4 },
        NOW - 48 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_failed',
        'ada',
        { act: 'h1', lease_id: 'L3', reason: 'lease_expired' },
        NOW - 47 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_cost',
        'ada',
        { act: 'h1', lease_id: 'Lz', cost_usd: 0 },
        NOW - 46 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'h2', lease_id: 'Lflight' },
        NOW - 45 * 60_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_deferred',
        'ada',
        { act: 'h3', lease_id: 'Ldef' },
        NOW - 44 * 60_000,
      );

      await setPolicy(db, team.id, { unpriced_wake_cap: 2 });
      const over = await deriveReport(db, team.id, 'revive', NOW);
      // L1 captured, L3 settled with no cost, Lz printed 0. L2 is priced. Lflight and Ldef stay out.
      expect(over.wake?.unpriced_sessions).toBe(1);
      expect(over.wake?.unpriced_wake_count).toBe(3);
      expect(over.wake?.unpriced_over_cap).toBe(true);

      await setPolicy(db, team.id, { unpriced_wake_cap: 3 });
      const atCap = await deriveReport(db, team.id, 'revive', NOW);
      expect(atCap.wake?.unpriced_wake_count).toBe(3);
      expect(atCap.wake?.unpriced_over_cap).toBe(true);

      await setPolicy(db, team.id, { unpriced_wake_cap: 4 });
      const under = await deriveReport(db, team.id, 'revive', NOW);
      expect(under.wake?.unpriced_wake_cap).toBe(4);
      expect(under.wake?.unpriced_wake_count).toBe(3);
      expect(under.wake?.unpriced_over_cap).toBe(false);
    });

    // The ADR 209/210 Eval split. The property that matters is NOT the counts — it is that an
    // unmeasured cohort stays distinguishable from a measured-zero one. Every wake in the real ledger
    // on 2026-08-04 predated ADR 209 and reported no delivery; if that rendered as `0 fresh`, a
    // baseline doc would record a measured result where there was no measurement at all.
    it('splits woken acts by delivery outcome and exact-match result', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'message', 'a1', NOW - 60_000);
      await directed(db, team, nick, ada, 'message', 'a2', NOW - 60_000);
      await directed(db, team, nick, ada, 'message', 'a3', NOW - 60_000);
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'a1', lease_id: 'L1', delivery_outcome: 'fresh', exact_match: 'missing' },
        NOW - 50_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'a2', lease_id: 'L2', delivery_outcome: 'resumed', exact_match: 'bound' },
        NOW - 50_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'a3', lease_id: 'L3', delivery_outcome: 'fresh_fallback', exact_match: 'stale' },
        NOW - 50_000,
      );

      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.wakes).toBe(3);
      expect(k.delivery).toEqual({ fresh: 1, resumed: 1, fresh_fallback: 1 });
      expect(k.delivery_measured).toBe(3);
      expect(k.exact_match).toEqual({ bound: 1, missing: 1, mismatched: 0, stale: 1 });
      expect(k.exact_match_measured).toBe(3);
    });

    it('reports an UNMEASURED cohort as measured=0, not as a row of zeros', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'message', 'b1', NOW - 60_000);
      // A pre-ADR-209 wake: it occupied, but carried no delivery axis at all.
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'b1', lease_id: 'L9', session: 'fresh' },
        NOW - 50_000,
      );

      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.wakes).toBe(1);
      // The counts are zero AND the denominator is zero — the pair is what says "no data".
      expect(k.delivery).toEqual({ fresh: 0, resumed: 0, fresh_fallback: 0 });
      expect(k.delivery_measured).toBe(0);
      expect(k.exact_match_measured).toBe(0);
    });

    it('a supplementary wake_cost row restating the delivery does not double-count', async () => {
      const { db, team, nick, ada } = await wakeSeed();
      await directed(db, team, nick, ada, 'message', 'c1', NOW - 60_000);
      await residencyRow(
        db,
        team.id,
        'residency.woke',
        'ada',
        { act: 'c1', lease_id: 'L5', delivery_outcome: 'resumed', exact_match: 'bound' },
        NOW - 50_000,
      );
      await residencyRow(
        db,
        team.id,
        'residency.wake_cost',
        'ada',
        {
          act: 'c1',
          lease_id: 'L5',
          cost_usd: 1.2,
          delivery_outcome: 'resumed',
          exact_match: 'bound',
        },
        NOW - 40_000,
      );

      const k = await deriveWakeMetrics(db, team.id, NOW);
      expect(k.delivery_measured).toBe(1);
      expect(k.exact_match_measured).toBe(1);
      expect(k.delivery.resumed).toBe(1);
    });
  });

  describe('deriveReviewMetrics (ADR 169) — the review eval, without an admin credential', async () => {
    /** One audit row of the two-stage-close shape. */
    const row = async (
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      action: 'lane.ready_for_review' | 'lane.closed' | 'lane.review_sent_back',
      detail: Record<string, unknown>,
    ) =>
      await appendAudit(db, teamId, {
        actor: 'ada',
        action,
        target: 'lane-x',
        result: 'allow',
        detail,
      });

    it('separates a routed review from a no-counterpart degradation — the whole point', async () => {
      const { db, team } = await seed();
      // Two lanes entered review: one found a counterpart, one did not.
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'a',
        reviewer: 'gee',
        route: 'cross_family',
      });
      await row(db, team.id, 'lane.ready_for_review', { lane: 'b', no_candidate: true });
      await row(db, team.id, 'lane.closed', {
        lane: 'a',
        reason: 'counterpart_confirm',
        verified: true,
      });
      await row(db, team.id, 'lane.closed', { lane: 'b', reason: 'no_candidate', verified: false });

      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.ready).toBe(2);
      expect(m.routed).toBe(1);
      expect(m.no_candidate).toBe(1);
      expect(m.closed.counterpart_confirm).toBe(1);
      expect(m.closed.no_candidate).toBe(1);
      // The catch rate a consumer computes is sent_back/routed — 0/1 here, an honest zero over a real
      // denominator. Over lanes-marked-ready it would read 0/2 and mean nothing.
      expect(m.sent_back).toBe(0);
    });

    it('counts a HAND-ROUTED ask as its own outcome — out of the picker denominator, not unknown', async () => {
      // ADR 348 decision 4, and it was violated the day the ADR was written (izzo's review of #1152):
      // a named row carries a `reviewer`, so it landed in `routed` — the catch rate's denominator,
      // which is a statement about the PICKER's asks. Hand-routed asks go where someone expects a
      // careful read, so mixing them changes what "caught N%" measures without changing what it says.
      //
      // The second assertion is the trap for whoever fixes the first: split `named` out of `routed`
      // WITHOUT adding it to the report's subtraction and every hand-routed lane is reported as
      // predating a 2026-07 fix — the exact ADR 234 bug, fourth outcome.
      const { db, team } = await seed();
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'a',
        reviewer: 'ghost',
        route: 'named',
      });
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'b',
        reviewer: 'izzo',
        route: 'cross_family',
      });
      await row(db, team.id, 'lane.review_sent_back', { lane: 'b' });

      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.ready).toBe(2);
      expect(m.named).toBe(1);
      // The picker routed ONE ask, and the catch rate is 1/1 over it — not 1/2 diluted by an ask the
      // picker never sent.
      expect(m.routed).toBe(1);
      expect(m.sent_back).toBe(1);
      expect(m.no_candidate).toBe(0);
      // Nothing left "unknown": the report's subtraction must include `named`.
      expect(m.ready - m.routed - m.no_candidate - m.acceptance_exempt - m.named).toBe(0);
    });

    it('counts an exemption as its own outcome — not routed, not no-candidate, not unknown', async () => {
      // ADR 234 increment 2. An exempt ready row carries neither `reviewer` nor `no_candidate`, so
      // without its own clause it would land in the abstain bucket and the report would call a
      // designed exemption "predates routing-outcome recording" — an unknown asserted about the one
      // row that knows exactly what it did. And its close, left to the `else`, would count as
      // `unknown_reason`: "written by a newer build, upgrade the reader", for a reason this build
      // writes itself.
      const { db, team } = await seed();
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'a',
        acceptance_exempt: true,
        stakes: 'low',
      });
      await row(db, team.id, 'lane.closed', {
        lane: 'a',
        reason: 'acceptance_exempt',
        verified: false,
      });

      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.ready).toBe(1);
      expect(m.acceptance_exempt).toBe(1);
      expect(m.routed).toBe(0);
      expect(m.no_candidate).toBe(0); // the degradation count must not absorb a design choice
      expect(m.ready - m.routed - m.no_candidate - m.acceptance_exempt).toBe(0); // nothing left "unknown"
      expect(m.closed.acceptance_exempt).toBe(1);
      expect(m.closed.no_candidate).toBe(0);
      expect(m.closed.self_close).toBe(0);
      expect(m.closed.unknown_reason).toBe(0);
      expect(m.closed.legacy_unlabelled).toBe(0);
    });

    it('counts a sampled-in low lane as ROUTED, and separately as the sample', async () => {
      // The 1-in-5 hole routes exactly like `normal`, so it belongs in the catch rate's denominator.
      // `exempt_sampled` rides beside it as the sample size the low tier is producing — the number
      // that says whether the tier is still being measured at all.
      const { db, team } = await seed();
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'a',
        reviewer: 'gee',
        route: 'cross_family',
        stakes: 'low',
        exempt_sampled: true,
      });
      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.routed).toBe(1);
      expect(m.exempt_sampled).toBe(1);
      expect(m.acceptance_exempt).toBe(0); // it was NOT exempt — it was drawn in and asked
    });

    it('counts a review catch, and keeps timeout distinct from no-counterpart', async () => {
      const { db, team } = await seed();
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'a',
        reviewer: 'gee',
        route: 'cross_family',
      });
      await row(db, team.id, 'lane.review_sent_back', { lane: 'a', reviewer: 'gee', owner: 'ada' });
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'b',
        reviewer: 'gee',
        route: 'cross_family',
      });
      await row(db, team.id, 'lane.closed', {
        lane: 'b',
        reason: 'review_timeout',
        verified: false,
      });

      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.sent_back).toBe(1);
      expect(m.routed).toBe(2);
      expect(m.closed.review_timeout).toBe(1);
      expect(m.closed.no_candidate).toBe(0); // a timeout is NOT a missing counterpart
    });

    // ADR 217: the two halves the old `review_timeout` conflated each get a bucket, and the old label
    // survives as the abstention for rows whose promised window was never recorded. All three must be
    // matched EXPLICITLY — if either new reason fell to the `else` it would be counted as
    // `unknown_reason`, and the metric would report ignorance about rows that stated themselves
    // plainly (the ADR 173 failure this projection has already made twice).
    it('counts the cut-short and unanswered halves apart, and keeps the abstention distinct', async () => {
      const { db, team } = await seed();
      await row(db, team.id, 'lane.closed', {
        lane: 'a',
        reason: 'review_unanswered',
        verified: false,
      });
      await row(db, team.id, 'lane.closed', {
        lane: 'b',
        reason: 'review_cut_short',
        verified: false,
      });
      await row(db, team.id, 'lane.closed', {
        lane: 'c',
        reason: 'review_cut_short',
        verified: false,
      });
      await row(db, team.id, 'lane.closed', {
        lane: 'd',
        reason: 'review_timeout',
        verified: false,
      });

      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.closed.review_unanswered).toBe(1);
      expect(m.closed.review_cut_short).toBe(2);
      expect(m.closed.review_timeout).toBe(1);
      expect(m.closed.unknown_reason).toBe(0);
      expect(m.closed.total).toBe(4);
    });

    it('legacy rows abstain from the routed/no-candidate split rather than being guessed', async () => {
      const { db, team } = await seed();
      // Written before the routing outcome was recorded (pre-#450): neither field present.
      await row(db, team.id, 'lane.ready_for_review', { lane: 'a', owner: 'ada' });
      await row(db, team.id, 'lane.closed', { lane: 'a', verified: false }); // and no reason at all

      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.ready).toBe(1);
      expect(m.routed).toBe(0);
      expect(m.no_candidate).toBe(0); // counted in neither — we do not know
      expect(m.closed.total).toBe(1);
      // This used to assert `self_close`, which reads as "never entered review" — a positive claim
      // about a row that recorded nothing. It abstains now: the ready split already refuses to guess
      // for this row, and the close bucket has to refuse on the same evidence or the two disagree.
      expect(m.closed.legacy_unlabelled).toBe(1);
      expect(m.closed.self_close).toBe(0);
    });

    it('is zero-shaped on a team that has never used review', async () => {
      const { db, team } = await seed();
      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.ready).toBe(0);
      expect(m.closed.total).toBe(0);
      expect(m.window_ms).toBeGreaterThan(0);
    });

    // ADR 172's counter-metric was invisible in the one report meant to show it: `human_review_missed`
    // had no bucket, so the reason-ladder's `else` swept those closes into `self_close` — "never
    // entered review", of a lane that demonstrably entered review and whose required human never came.
    it('counts a human_review_missed close as itself, NOT as a self-close', async () => {
      const { db, team } = await seed();
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'a',
        no_candidate: true,
        human_required: true,
      });
      await row(db, team.id, 'lane.closed', {
        lane: 'a',
        reason: 'human_review_missed',
        human_review_missed: true,
        verified: false,
      });

      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.closed.human_review_missed).toBe(1);
      expect(m.closed.self_close).toBe(0); // the miscount this replaces
      expect(m.closed.no_candidate).toBe(0); // and not folded into the sanctioned degradation either
    });

    // Clause 4: an abstention must be VISIBLE, not merely absent from a count. The close edge records
    // that it could not tell; the report carries the total so a reader knows how much the
    // human_review_missed number abstained over.
    it('surfaces how many closes could not tell whether a human was required', async () => {
      const { db, team } = await seed();
      await row(db, team.id, 'lane.ready_for_review', { lane: 'a', no_candidate: true }); // pre-#462 row
      await row(db, team.id, 'lane.closed', {
        lane: 'a',
        reason: 'no_candidate',
        human_required_unknown: true,
        verified: false,
      });
      await row(db, team.id, 'lane.closed', { lane: 'b', reason: 'self_close', verified: false });

      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.closed.human_required_unknown).toBe(1);
      expect(m.closed.human_review_missed).toBe(0); // never inferred from an abstention
    });

    // The residual #517 left behind, one level below the bucket it added. `self_close` is a REAL
    // recorded reason — "never entered review" — so the ladder's `else` must not also absorb the two
    // ways of not knowing. They are different facts with different remedies (nothing to do about a
    // legacy row; upgrade the reader for a reason a newer build wrote), so clause 1 gives them
    // different names rather than one `unknown`.
    it('separates an unrecognised reason from one that was never recorded, and from a real self-close', async () => {
      const { db, team } = await seed();
      await row(db, team.id, 'lane.closed', {
        lane: 'a',
        reason: 'some_future_reason',
        verified: false,
      });
      await row(db, team.id, 'lane.closed', { lane: 'b', verified: false }); // no reason at all
      await row(db, team.id, 'lane.closed', { lane: 'c', reason: 'self_close', verified: false });

      const m = (await deriveReport(db, team.id, 'revive')).review!;
      expect(m.closed.unknown_reason).toBe(1);
      expect(m.closed.legacy_unlabelled).toBe(1);
      expect(m.closed.self_close).toBe(1); // only an EXPLICIT self_close is one
      expect(m.closed.total).toBe(3);
    });

    // The arithmetic a reader does on this panel has to close, or an abstention that is merely
    // uncounted is as misleading as one that is miscounted.
    it('the reason buckets sum to total, so nothing hides in a rounding gap', async () => {
      const { db, team } = await seed();
      await row(db, team.id, 'lane.closed', {
        lane: 'a',
        reason: 'counterpart_confirm',
        verified: true,
      });
      await row(db, team.id, 'lane.closed', {
        lane: 'b',
        reason: 'review_timeout',
        verified: false,
      });
      await row(db, team.id, 'lane.closed', { lane: 'c', reason: 'no_candidate', verified: false });
      await row(db, team.id, 'lane.closed', {
        lane: 'd',
        reason: 'human_review_missed',
        verified: false,
      });
      await row(db, team.id, 'lane.closed', { lane: 'e', reason: 'self_close', verified: false });
      await row(db, team.id, 'lane.closed', { lane: 'f', reason: 'abandoned', verified: false });
      await row(db, team.id, 'lane.closed', { lane: 'g', reason: 'who_knows', verified: false });
      await row(db, team.id, 'lane.closed', { lane: 'h', verified: false });

      const c = (await deriveReport(db, team.id, 'revive')).review!.closed;
      const summed =
        c.counterpart_confirm +
        c.review_timeout +
        c.no_candidate +
        c.human_review_missed +
        c.self_close +
        c.abandoned +
        c.unknown_reason +
        c.legacy_unlabelled;
      expect(summed).toBe(c.total);
      expect(c.total).toBe(8);
    });
  });
  describe('deriveDisputes (ADR 505 §8 — the readout as a report block, replacing ADR 481)', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const T = 100 * DAY;

    it('selects the four dispute acts on this team in the 30-day cut — and counts exactly what the shared definitions count', async () => {
      const { db, team, nick, ada } = await seed();
      const bo = (await addMember(db, team, { name: 'bo', kind: 'agent' })).row;
      const other = await createTeam(db, { slug: 'other' });
      const ghost = (await addMember(db, other, { name: 'ghost', kind: 'agent' })).row;
      const put = async (
        t: typeof team,
        from: { id: string; name: string },
        id: string,
        act: Act,
        body: string,
        ts: number,
        meta?: Record<string, unknown>,
      ) =>
        insertMessage(
          db,
          t.id,
          from.id,
          null,
          makeEnvelope({
            id,
            team: t.slug,
            from: from.name,
            to: { kind: 'team' },
            act,
            body,
            ts,
            ...(meta ? { meta } : {}),
          }),
        );
      // A bare challenge (pre-stamp shape) conceded without a check; a stamped review rejection
      // held with evidence, then a tiebreak that sided with the owner.
      await put(team, nick, 'ch1', 'challenge', 'are you sure?', T - 3 * DAY);
      await put(team, ada, 'a1', 'accept', 'fine', T - 3 * DAY + 1, { in_reply_to: 'ch1' });
      await put(team, ada, 'ask1', 'ask', '[lane] acceptance requested', T - 2 * DAY, {
        lane_review: { lane: 'L1' },
        species: 'approve',
        tier: 'standard',
      });
      await put(team, bo, 'rej1', 'decline', 'missing the re-run', T - 2 * DAY + 1, {
        in_reply_to: 'ask1',
        dispute: { via: 'review', lane: 'L1', ask: 'ask1' },
      });
      await put(team, ada, 'hold1', 'decline', 'holding: perf/x.md:12 has it', T - 2 * DAY + 2, {
        in_reply_to: 'rej1',
      });
      await put(
        team,
        ada,
        'tb1',
        'ask',
        '[lane] acceptance requested — TIEBREAK',
        T - 2 * DAY + 3,
        {
          lane_review: {
            lane: 'L1',
            tiebreak: { rejection: 'rej1', hold: 'hold1', first_reviewer: 'bo' },
          },
          species: 'approve',
          tier: 'standard',
        },
      );
      await put(team, nick, 'v1', 'accept', 'the hold stands', T - 2 * DAY + 4, {
        in_reply_to: 'tb1',
      });
      // excluded: another team, and one outside the window
      await put(other, ghost, 'o1', 'challenge', 'prove it', T - DAY);
      await put(team, nick, 'old', 'challenge', 'old', T - 40 * DAY);

      const since = T - 30 * DAY;
      const block = await deriveDisputes(db, team.id, T);
      expect(block.by_via.challenge).toMatchObject({
        opened: 1,
        answered: 1,
        conceded: 1,
        named_check: 0,
      });
      expect(block.by_via.review).toEqual({
        opened: 1,
        answered: 1,
        conceded: 0,
        held: 1,
        named_check: 1,
        message_only: 0,
        tiebreak: { settled: 1, hold_stood: 1 },
      });
      expect(block.by_via.dependency.opened).toBe(0);
      expect(block.total.opened).toBe(2);
      expect(block.by_seat).toEqual([
        { seat: 'ada', answered: 2, named_check: 1, conceded: 1, held: 1 },
      ]);
      // Parity: the block IS the shared definition over the rows the SQL selected.
      const raw = await db.all<RawDisputeRow>(
        `SELECT r.id AS id, mem.name AS seat, mem.kind AS kind, r.act AS act, r.body AS body,
                r.meta AS meta, r.in_reply_to AS "inReplyTo", r.ts AS ts,
                p.act AS "parentAct", p.meta AS "parentMeta"
           FROM messages r JOIN members mem ON mem.id = r.from_member
           LEFT JOIN messages p ON p.id = r.in_reply_to
          WHERE r.team_id = ? AND r.ts >= ? AND r.act IN ('challenge','decline','accept','ask')
          ORDER BY r.ts, r.id`,
        [team.id, since],
      );
      expect(block).toEqual(summariseDisputes(raw.map(toDisputeRow), since));
    });
  });
});
