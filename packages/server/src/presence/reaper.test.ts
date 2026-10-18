import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig, type ResolvedConfig } from '../config.js';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { saveNodeEnrollment } from '../node/state.js';
import { appendAudit, listAudit } from '../store/audit.js';
import { openIncidents, recordBlockedReport } from '../store/incidents.js';
import { getLane, openLane, updateLane } from '../store/lanes.js';
import { SWEEP_GRACE_MS } from '../store/laneSweep.js';
import { addMember } from '../store/members.js';
import { insertMessage, localNodeForTeam } from '../store/messages.js';
import { attach, presenceById, release } from '../store/presence.js';
import { createRequest } from '../store/requests.js';
import {
  HOST_SUSPEND_GAP_MS,
  WAKE_LEASE_TTL_MS,
  WAKE_UNREACHABLE_CEILING_MS,
  claimWakeLeases,
  enrollResidency,
} from '../store/residency.js';
import { createTeam, setPolicy, type TeamRow } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { startReaper } from './reaper.js';

let openStore: () => Promise<Driver>;

withDrivers('reaper', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * The reaper is a `setInterval` tick, so drive it with fake timers: seed a stale row, advance one
   * `reaperIntervalMs`, and assert the tick's side effects (offline broadcast, request expiry, audit).
   */
  describe('startReaper', async () => {
    let db: Database;
    let hub: Hub;
    let config: ResolvedConfig;
    let ctx: Ctx;
    let stop: (() => void) | undefined;

    beforeEach(async () => {
      vi.useFakeTimers();
      db = await openStore();
      hub = new Hub();
      config = resolveConfig();
      ctx = { db: db, hub, config, rosterRoots: [] };
    });

    afterEach(() => {
      stop?.();
      stop = undefined;
      vi.useRealTimers();
      db.close();
    });

    async function seatWithPresence(
      name: string,
    ): Promise<{ memberId: string; presenceId: string }> {
      const team = await createTeam(db, { slug: 'dawn' });
      const { row } = await addMember(db, team, { name, kind: 'agent' });
      const presence = await attach(db, row.id, 'cli', 'conn-1');
      return { memberId: row.id, presenceId: presence.id };
    }

    it('reaps a stale live presence and broadcasts the member offline', async () => {
      const { presenceId } = await seatWithPresence('Ada');
      // Backdate the row so it is already stale, then let one tick sweep it.
      await db.run('UPDATE presence SET last_seen_at = ? WHERE id = ?', [
        Date.now() - config.presenceTimeoutMs - 1,
        presenceId,
      ]);
      const broadcast = vi.spyOn(hub, 'broadcastTeam');

      stop = startReaper(ctx);
      // A freshly started loop has not heard a full timeout window yet, so it judges nobody: before
      // this, a daemon bounce reaped every presence on its first tick and every session lease with it
      // (lane 01M1HNY302). The row survives until the loop has actually been listening that long.
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);
      expect(broadcast).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(config.presenceTimeoutMs);

      expect(broadcast).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'presence', member: 'Ada', status: 'offline' }),
      );
    });

    it('a stall as long as the timeout restarts the listening window — a row is not reaped on the tick that notices the gap', async () => {
      const broadcast = vi.spyOn(hub, 'broadcastTeam');

      stop = startReaper(ctx);
      // Run continuously long enough that the loop is entitled to judge, then take a live seat.
      await vi.advanceTimersByTimeAsync(config.presenceTimeoutMs + config.reaperIntervalMs);
      const { presenceId } = await seatWithPresence('Cy');

      // The process stalls (a suspend, a blocked event loop): the clock moves, no tick runs, and no
      // heartbeat could have been heard either. The row goes stale purely because nobody was there.
      vi.setSystemTime(Date.now() + config.presenceTimeoutMs * 4);
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);
      expect(broadcast).not.toHaveBeenCalled();
      expect(await presenceById(db, presenceId)).toBeDefined();

      // Given a full window with the loop actually running and still no heartbeat, it is silent.
      await vi.advanceTimersByTimeAsync(config.presenceTimeoutMs);
      expect(broadcast).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'presence', member: 'Cy', status: 'offline' }),
      );
    });

    it('a tick that itself blocks past the timeout reaps nothing — the guard and the cutoff run on the clock the tick started with', async () => {
      const broadcast = vi.spyOn(hub, 'broadcastTeam');

      stop = startReaper(ctx);
      await vi.advanceTimersByTimeAsync(config.presenceTimeoutMs + config.reaperIntervalMs);
      const { presenceId } = await seatWithPresence('Di');

      // The next tick starts on time and then blocks inside its own body for longer than the timeout
      // (a wedged daemon straight after a host resume — measured 2026-09-14 15:57:46Z, one tick of
      // ~104s that reaped ghost, wanderer and dolly 51s in while their sockets were open). Every
      // Date.now() after the tick's first read returns a clock past the timeout; the seat's
      // heartbeat is in the socket buffer, unreadable until the tick returns.
      const faked = Date.now;
      let reads = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        reads += 1;
        return reads === 1 ? faked() : faked() + config.presenceTimeoutMs + 1;
      });
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);
      vi.restoreAllMocks();

      expect(broadcast).not.toHaveBeenCalled();
      expect(await presenceById(db, presenceId)).toBeDefined();
    });

    it('does not broadcast offline when only a grace-held row expires', async () => {
      const { presenceId } = await seatWithPresence('Bo');
      // A released (held) presence expiring is not a state change — the member already went offline.
      await release(db, presenceId, config.reclaimGraceMs);
      await db.run('UPDATE presence SET held_until = ?, last_seen_at = ? WHERE id = ?', [
        Date.now() - 1,
        Date.now() - config.presenceTimeoutMs - 1,
        presenceId,
      ]);
      const broadcast = vi.spyOn(hub, 'broadcastTeam');

      stop = startReaper(ctx);
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);

      expect(broadcast).not.toHaveBeenCalled();
    });

    it('expires a pending claim request past its deadline and refuses the session', async () => {
      const team = await createTeam(db, { slug: 'dawn' });
      const req = await createRequest(db, team.id, {
        kind: 'claim',
        from_session: 'sess-9',
        target: 'seat:Ada',
      });
      await db.run('UPDATE requests SET expires_at = ? WHERE id = ?', [Date.now() - 1, req.id]);
      const deliver = vi.spyOn(hub, 'deliverClaimDecision').mockReturnValue(true);

      stop = startReaper(ctx);
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);

      expect(deliver).toHaveBeenCalledWith(
        'sess-9',
        expect.objectContaining({ type: 'refused', code: 'expired_grant' }),
      );
      const audit = (await listAudit(db, team.id)).find((a) => a.action === 'request.expired');
      expect(audit).toBeDefined();
    });

    it('is a no-op tick when nothing is stale, and stop() clears the interval', async () => {
      await seatWithPresence('Fresh');
      const broadcast = vi.spyOn(hub, 'broadcastTeam');

      stop = startReaper(ctx);
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs * 2);
      expect(broadcast).not.toHaveBeenCalled();

      stop();
      stop = undefined;
      // After stopping, further time must not trigger any more work.
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs * 5);
      expect(broadcast).not.toHaveBeenCalled();
    });

    /**
     * ADR 236: an expired lease means one of two opposite things — the host tried and failed (burn the
     * attempt budget, or a crash-looping host retries forever) or the host was not there at all (burn
     * nothing, or the act is retired before anyone could answer it). The discriminator is the reaper's
     * own cadence: a 15-second loop that did not fire for a quarter hour was suspended, not late.
     *
     * The suspension is simulated the way macOS causes it — the wall clock jumps while the timer queue
     * does not fire — via `setSystemTime` followed by a single interval.
     */
    describe('a lease that expired while the host was unreachable (ADR 236)', async () => {
      const HOST = 'laptop.local';

      /** A real due wake, leased through `claimWakeLeases` — same rows production writes. */
      async function leaseDueWake(): Promise<{ teamId: string; seat: string }> {
        const team = await createTeam(db, { slug: 'revive' });
        const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
        const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
        await enrollResidency(db, team.id, {
          member_id: ada.id,
          harness: 'claude-code',
          host: HOST,
          grant_id: 'g1',
          authorized_by: 'nick',
        });
        await insertMessage(
          db,
          team.id,
          nick.id,
          ada.id,
          makeEnvelope({
            id: 'u1',
            team: team.slug,
            from: nick.name,
            to: { kind: 'member', name: ada.name },
            act: 'message',
            body: 'x',
            thread: null,
            meta: { urgent: true, urgent_reason: 'wake me' },
            ts: Date.now(),
          }),
        );
        const orders = await claimWakeLeases(
          db,
          team.id,
          team.slug,
          HOST,
          config.presenceTimeoutMs,
        );
        expect(orders).toHaveLength(1);
        return { teamId: team.id, seat: ada.name };
      }

      const rows = async (teamId: string, action: string) =>
        (await listAudit(db, teamId)).filter((a) => a.action === action);
      const detailOf = (row: { detail: unknown }) =>
        JSON.parse(row.detail as string) as Record<string, unknown>;

      /** Sleep the host: the clock jumps, the timer queue does not fire, then one tick catches up —
       *  so the tick that follows observes exactly `gapMs` since the previous one. */
      async function suspendThenTick(gapMs: number) {
        vi.setSystemTime(Date.now() + gapMs - config.reaperIntervalMs);
        await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);
      }

      it('burns the attempt budget when the loop ran on schedule (a host-reported failure)', async () => {
        const { teamId } = await leaseDueWake();
        stop = startReaper(ctx);
        // Ticks fire every interval throughout: the daemon was demonstrably alive the whole time.
        await vi.advanceTimersByTimeAsync(WAKE_LEASE_TTL_MS + config.reaperIntervalMs);

        expect(await rows(teamId, 'residency.wake_failed')).toHaveLength(1);
        expect(detailOf((await rows(teamId, 'residency.wake_failed'))[0]!).reason).toBe(
          'lease_expired',
        );
        expect(await rows(teamId, 'residency.wake_deferred')).toHaveLength(0);
      });

      // ADR 252: `residency.wake_cost` is written only when a host REPORTS, so a wake that spawned a
      // session and then died on its lease is paid for and invisible. The session's own attested
      // token is the evidence — the expiry row carries the fact, and deliberately no dollar figure:
      // no cost source exists on this path, and a made-up number is worse than an honest gap.
      it('stamps session_captured on an expired lease that a session attested (paid, unpriced)', async () => {
        const { teamId } = await leaseDueWake();
        const leaseId = (await db.get('SELECT id FROM wake_leases WHERE team_id = ?', [teamId]))!
          .id;
        await appendAudit(db, teamId, {
          actor: null,
          action: 'residency.session_captured',
          target: 'Ada',
          result: 'allow',
          detail: { harness: 'claude-code', enrolled: true, wake_lease: leaseId },
        });

        stop = startReaper(ctx);
        await vi.advanceTimersByTimeAsync(WAKE_LEASE_TTL_MS + config.reaperIntervalMs);

        const failed = detailOf((await rows(teamId, 'residency.wake_failed'))[0]!);
        expect(failed.reason).toBe('lease_expired');
        expect(failed.session_captured).toBe(true);
        expect(failed).not.toHaveProperty('cost_usd');
      });

      it('says nothing when no session claimed the lease — silence, not a denial', async () => {
        const { teamId } = await leaseDueWake();
        // A session captured under a DIFFERENT lease must not be credited to this one: the join is
        // by identity, never by "a session happened around then" (the ADR 238→241 inference).
        await appendAudit(db, teamId, {
          actor: null,
          action: 'residency.session_captured',
          target: 'Ada',
          result: 'allow',
          detail: { harness: 'claude-code', enrolled: true, wake_lease: 'some-other-lease' },
        });

        stop = startReaper(ctx);
        await vi.advanceTimersByTimeAsync(WAKE_LEASE_TTL_MS + config.reaperIntervalMs);

        expect(detailOf((await rows(teamId, 'residency.wake_failed'))[0]!)).not.toHaveProperty(
          'session_captured',
        );
      });

      it('defers instead — and records the suspension — when the loop did not run', async () => {
        const { teamId, seat } = await leaseDueWake();
        stop = startReaper(ctx);
        await suspendThenTick(15 * 60_000);

        expect(await rows(teamId, 'residency.wake_failed')).toHaveLength(0);
        const deferred = await rows(teamId, 'residency.wake_deferred');
        expect(deferred).toHaveLength(1);
        expect(deferred[0]!.target).toBe(seat);
        expect(detailOf(deferred[0]!).reason).toBe('host_unreachable');

        const suspended = await rows(teamId, 'residency.host_suspended');
        expect(suspended).toHaveLength(1);
        expect(detailOf(suspended[0]!).gap_ms).toBeGreaterThanOrEqual(15 * 60_000);
      });

      it('does not read a minute of scheduler lateness as absence (the threshold has headroom)', async () => {
        // Pinned in absolute time, not against the constant: a loaded machine can starve a 15-second
        // loop for a minute, and calling that "the host was gone" would defer every real failure.
        const { teamId } = await leaseDueWake();
        stop = startReaper(ctx);
        await suspendThenTick(60_000);

        expect(await rows(teamId, 'residency.host_suspended')).toHaveLength(0);
      });

      it('treats a gap under the suspend threshold as ordinary lateness, not absence', async () => {
        const { teamId } = await leaseDueWake();
        stop = startReaper(ctx);
        await suspendThenTick(HOST_SUSPEND_GAP_MS - 1_000);
        // ...then keep ticking on schedule until the lease is genuinely past its TTL.
        await vi.advanceTimersByTimeAsync(WAKE_LEASE_TTL_MS);

        expect(await rows(teamId, 'residency.host_suspended')).toHaveLength(0);
        expect(await rows(teamId, 'residency.wake_deferred')).toHaveLength(0);
        expect(await rows(teamId, 'residency.wake_failed')).toHaveLength(1);
      });

      it('a deferred expiry burns no attempt budget: the act re-leases once the snooze lifts', async () => {
        const { teamId } = await leaseDueWake();
        const team = { id: teamId };
        stop = startReaper(ctx);
        await suspendThenTick(15 * 60_000);

        // Lift the deferral snooze; nothing else about the act has changed.
        await db.run("UPDATE audit SET ts = ? WHERE action = 'residency.wake_deferred'", [
          Date.now() - 10 * 60_000,
        ]);
        const again = await claimWakeLeases(db, team.id, 'revive', HOST, config.presenceTimeoutMs);
        expect(again).toHaveLength(1);
        expect(again[0]!.act_id).toBe('u1');
      });

      it('stops deferring once the host has been awake past the ceiling (defer is bounded)', async () => {
        const { teamId } = await leaseDueWake();
        // Backdate the act's first lease so the host has since been awake well past the ceiling —
        // the sleep below is subtracted from that span, so the margin has to exceed it.
        await db.run("UPDATE audit SET ts = ? WHERE action = 'residency.wake_leased'", [
          Date.now() - (WAKE_UNREACHABLE_CEILING_MS + 30 * 60_000),
        ]);
        stop = startReaper(ctx);
        await suspendThenTick(15 * 60_000);

        expect(await rows(teamId, 'residency.wake_deferred')).toHaveLength(0);
        expect(await rows(teamId, 'residency.wake_failed')).toHaveLength(1);
      });

      it('counts only awake time toward the ceiling: a long sleep does not spend it', async () => {
        const { teamId } = await leaseDueWake();
        const now = Date.now();
        // The act's first lease is older than the ceiling in WALL-CLOCK time — but the host spent
        // nearly all of that span asleep, in one recorded suspension. Awake time is what rules.
        await db.run("UPDATE audit SET ts = ? WHERE action = 'residency.wake_leased'", [
          now - (WAKE_UNREACHABLE_CEILING_MS + 60 * 60_000),
        ]);
        await appendAudit(db, teamId, {
          actor: null,
          action: 'residency.host_suspended',
          target: 'daemon',
          result: 'allow',
          detail: {
            gap_ms: WAKE_UNREACHABLE_CEILING_MS,
            from: now - (WAKE_UNREACHABLE_CEILING_MS + 30 * 60_000),
            to: now - 30 * 60_000,
          },
        });
        stop = startReaper(ctx);
        await suspendThenTick(15 * 60_000);

        expect(await rows(teamId, 'residency.wake_failed')).toHaveLength(0);
        expect(await rows(teamId, 'residency.wake_deferred')).toHaveLength(1);
      });
    });
  });

  /**
   * Lane 01M2RQ8W0RR838P2KW3SP6SYGV — the silent departure.
   *
   * ADR 412 re-routes an acceptance when a seat says goodbye. A reaped seat says nothing: it emits
   * `presence.detached` with reason 'reaped' and no `residency.session_ended`, so 412's trigger never
   * fires. On revive, where `loops.sweep` is not armed, such an ask waits forever — the 12h
   * `stale_acceptance` warning is advisory and ADR 229's 24h close never runs.
   */
  describe('startReaper — an acceptance held by a seat that vanished without a goodbye', async () => {
    let db: Database;
    let hub: Hub;
    let config: ResolvedConfig;
    let ctx: Ctx;
    let stop: (() => void) | undefined;

    beforeEach(async () => {
      vi.useFakeTimers();
      db = await openStore();
      hub = new Hub();
      config = resolveConfig();
      ctx = { db: db, hub, config, rosterRoots: [] };
    });

    afterEach(() => {
      stop?.();
      stop = undefined;
      vi.useRealTimers();
      db.close();
    });

    async function laneHeldByADepartedSeat({
      holderStale = true,
      holderKind = 'agent' as 'agent' | 'human',
      laneReview = {} as Record<string, unknown>,
    } = {}) {
      const team = await createTeam(db, { slug: 'dawn' });
      const worker = (await addMember(db, team, { name: 'Kim', kind: 'agent' })).row;
      const gone = (await addMember(db, team, { name: 'delta', kind: holderKind })).row;
      const live = (await addMember(db, team, { name: 'Lin', kind: 'agent' })).row;
      // Lin is here and says what she is running; the picker routes on the live occupancy (ADR 101).
      const lin = await attach(db, live.id, 'cli', 'conn-lin', { model: 'gpt-5.6-sol' });
      // delta held a presence and it went stale — the reap, not a goodbye.
      const holder = await attach(db, gone.id, 'cli', 'conn-delta', { model: 'claude-opus-5' });
      if (holderStale) {
        await db.run('UPDATE presence SET last_seen_at = ? WHERE id = ?', [
          Date.now() - config.presenceTimeoutMs - 1,
          holder.id,
        ]);
      }
      const lane = await openLane(db, team.id, team.slug, 'Kim', {
        title: 'kim lane',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { state: 'awaiting_acceptance' });
      await insertMessage(
        db,
        team.id,
        worker.id,
        gone.id,
        makeEnvelope({
          id: 'ask-vanished',
          team: team.slug,
          from: 'Kim',
          to: { kind: 'member', name: 'delta' },
          act: 'ask',
          body: '[lane] acceptance requested',
          meta: {
            species: 'approve',
            tier: 'standard',
            lane_review: { lane: lane.id, ...laneReview },
          },
          ts: 1_000,
        }),
      );
      return { team, lane, linPresence: lin.id, holderPresence: holder.id };
    }

    const heartbeat = async (presenceId: string) =>
      await db.run('UPDATE presence SET last_seen_at = ? WHERE id = ?', [Date.now(), presenceId]);

    /** Let `ms` pass a tick at a time with these rows heartbeating, as live sockets would. */
    async function liveFor(ms: number, ...presenceIds: string[]) {
      for (let t = 0; t < ms; t += config.reaperIntervalMs) {
        for (const id of presenceIds) await heartbeat(id);
        await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);
      }
    }

    const rerouted = async (teamId: string) =>
      (await listAudit(db, teamId)).filter((r) => r.action === 'lane.review_rerouted');

    it('re-routes the acceptance to a live seat once the holder has been reaped', async () => {
      const { team, lane, linPresence } = await laneHeldByADepartedSeat();

      stop = startReaper(ctx);
      // The loop judges nobody until it has listened for a full timeout window (lane 01M1HNY302) —
      // the acceptance sweep included (lane 01M4BJX7JJ), so Lin has to stay live across it.
      await liveFor(config.presenceTimeoutMs + config.reaperIntervalMs * 2, linPresence);

      const rows = await rerouted(team.id);
      expect(rows).toHaveLength(1);
      const detail = JSON.parse(rows[0]!.detail as string);
      expect(detail.lane).toBe(lane.id);
      expect(detail.from_reviewer).toBe('delta');
      expect(detail.superseded_ask).toBe('ask-vanished');
      expect(detail.reviewer).toBe('Lin');
      expect(detail.route).toBe('reaped');
    });

    it('never re-routes the stage-two human ask: an offline human is waited on, not replaced (lane 01M4V6ACBP)', async () => {
      // 2026-10-13, lane 01M4SPZB1V: the reaper moved nick's human ask to an agent as a fresh PEER
      // ask; that agent's accept re-asked nick, and the loop never reached the human's verdict.
      const { team, linPresence } = await laneHeldByADepartedSeat({
        holderKind: 'human',
        laneReview: { route: 'human_admin', grade: 'human', peer_confirmed_by: 'Lin' },
      });

      stop = startReaper(ctx);
      await liveFor(config.presenceTimeoutMs + config.reaperIntervalMs * 2, linPresence);

      expect(await rerouted(team.id)).toHaveLength(0);
    });

    it('re-routes a lane at most once, however many ticks pass', async () => {
      const { team, linPresence } = await laneHeldByADepartedSeat();

      stop = startReaper(ctx);
      await liveFor(config.presenceTimeoutMs + config.reaperIntervalMs * 20, linPresence);

      expect(await rerouted(team.id)).toHaveLength(1);
    });

    describe('the hop cap (ADR 595)', async () => {
      /** One submission's history: its `ready_for_review` row, then a hop per `routes` entry. */
      async function seedHops(teamId: string, laneId: string, routes: string[]) {
        await appendAudit(db, teamId, {
          actor: 'Kim',
          action: 'lane.ready_for_review',
          target: laneId,
          result: 'allow',
          detail: { lane: laneId, owner: 'Kim' },
        });
        for (const [i, route] of routes.entries()) {
          await appendAudit(db, teamId, {
            actor: `seat${i}`,
            action: 'lane.review_rerouted',
            target: laneId,
            result: 'allow',
            detail: { lane: laneId, route, from_reviewer: `seat${i}`, reviewer: `seat${i + 1}` },
          });
        }
      }

      /** Moves the sweep made — only they supersede the fixture's ask; seeded hops carry none. */
      const fresh = async (teamId: string) =>
        (await rerouted(teamId)).filter(
          (r) => JSON.parse(r.detail as string).superseded_ask === 'ask-vanished',
        );

      it('after three hops, the next move goes to a live human, not a fourth agent', async () => {
        // Measured 2026-10-07..14: ten submissions re-routed between agents more than twice, one six
        // times, each holder gone before judging it.
        const { team, lane, linPresence } = await laneHeldByADepartedSeat();
        const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
        const nickPresence = (await attach(db, nick.id, 'cli', 'conn-nick')).id;
        await seedHops(team.id, lane.id, ['reaped', 'departed', 'reaped']);

        stop = startReaper(ctx);
        await liveFor(
          config.presenceTimeoutMs + config.reaperIntervalMs * 2,
          linPresence,
          nickPresence,
        );

        const moved = await fresh(team.id);
        expect(moved).toHaveLength(1);
        const detail = JSON.parse(moved[0]!.detail as string);
        expect(detail.route).toBe('capped');
        expect(detail.reviewer).toBe('nick');
        expect(detail.superseded_ask).toBe('ask-vanished');
        expect(detail.hops).toBe(3);
        expect(detail.holders).toEqual(['seat0', 'seat1', 'seat2', 'delta']);
        const ask = await db.get<{ body: string; meta: string }>(
          `SELECT m.body, m.meta FROM messages m JOIN members mem ON mem.id = m.to_member
            WHERE mem.name = 'nick' AND m.act = 'ask'`,
        );
        expect(JSON.parse(ask!.meta).lane_review).toMatchObject({
          route: 'capped',
          grade: 'human',
        });
        expect(ask!.body).toContain('held by 4 seats in turn (seat0 → seat1 → seat2 → delta)');
      });

      it('with no human live it moves nowhere, and the first human to come live gets it', async () => {
        const { team, lane, linPresence } = await laneHeldByADepartedSeat();
        const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
        await seedHops(team.id, lane.id, ['reaped', 'reaped', 'reaped']);

        stop = startReaper(ctx);
        await liveFor(config.presenceTimeoutMs + config.reaperIntervalMs * 4, linPresence);
        expect(await fresh(team.id)).toHaveLength(0);

        const nickPresence = (await attach(db, nick.id, 'cli', 'conn-nick')).id;
        await liveFor(config.reaperIntervalMs * 4, linPresence, nickPresence);
        const moved = await fresh(team.id);
        expect(moved).toHaveLength(1);
        expect(JSON.parse(moved[0]!.detail as string).reviewer).toBe('nick');
      });

      it('counts one submission’s automatic hops only: a resubmit, a hand re-route or a tiebreak is no hop', async () => {
        const { team, lane, linPresence } = await laneHeldByADepartedSeat();
        const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
        const nickPresence = (await attach(db, nick.id, 'cli', 'conn-nick')).id;
        await seedHops(team.id, lane.id, ['reaped', 'reaped', 'reaped']);
        vi.setSystemTime(Date.now() + 1_000);
        await seedHops(team.id, lane.id, ['named', 'tiebreak', 'reaped']);

        stop = startReaper(ctx);
        await liveFor(
          config.presenceTimeoutMs + config.reaperIntervalMs * 2,
          linPresence,
          nickPresence,
        );

        const moved = await fresh(team.id);
        expect(moved).toHaveLength(1);
        const detail = JSON.parse(moved[0]!.detail as string);
        expect(detail.route).toBe('reaped');
        expect(detail.reviewer).toBe('Lin');
      });
    });

    it('a freshly booted loop moves no acceptance before it has listened a full window', async () => {
      const { team } = await laneHeldByADepartedSeat();

      stop = startReaper(ctx);
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);

      expect(await rerouted(team.id)).toHaveLength(0);
    });

    it('a host suspend moves no acceptance: overnight, every sleep re-routed the same ask (lane 01M4BJX7JJ)', async () => {
      // Measured 2026-10-06/07: lane 01M49JNJG3's acceptance moved 37 times, every row within 5 s
      // of a `residency.host_suspended` row. On wake the holder's heartbeat is stale by the clock
      // alone, while whichever seat's heartbeat landed first looks live — so the sweep moved the
      // ask to it, and the next sleep moved it again.
      stop = startReaper(ctx);
      await vi.advanceTimersByTimeAsync(config.presenceTimeoutMs + config.reaperIntervalMs);
      const { team, linPresence, holderPresence } = await laneHeldByADepartedSeat({
        holderStale: false,
      });
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);
      expect(await rerouted(team.id)).toHaveLength(0);

      // The laptop sleeps. On resume Lin's heartbeat arrives before the tick; delta's has not yet.
      vi.setSystemTime(Date.now() + HOST_SUSPEND_GAP_MS * 10);
      await heartbeat(linPresence);
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);
      expect(await rerouted(team.id)).toHaveLength(0);

      // delta reconnects inside the window, as a live adapter does: still nothing to move.
      await liveFor(config.presenceTimeoutMs * 2, linPresence, holderPresence);
      expect(await rerouted(team.id)).toHaveLength(0);
    });

    it('after a suspend, a holder that stays silent a full window is re-routed once', async () => {
      stop = startReaper(ctx);
      await vi.advanceTimersByTimeAsync(config.presenceTimeoutMs + config.reaperIntervalMs);
      const { team, linPresence } = await laneHeldByADepartedSeat({ holderStale: false });

      vi.setSystemTime(Date.now() + HOST_SUSPEND_GAP_MS * 10);
      await heartbeat(linPresence);
      await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);
      expect(await rerouted(team.id)).toHaveLength(0);

      await liveFor(config.presenceTimeoutMs * 3, linPresence);
      expect(await rerouted(team.id)).toHaveLength(1);
    });

    it('an enrolled joiner never re-routes: the departure is the hub’s to judge', async () => {
      // Second-machine run, 2026-10-02: a fresh joiner mid-drain saw every reviewer as absent (none
      // of them is resident there), re-routed eleven old acceptances AS those reviewers, and the hub
      // refused the batch `bound_elsewhere` — wedging every later push from the machine.
      const dir = mkdtempSync(join(tmpdir(), 'musterd-reaper-joiner-'));
      process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
      try {
        const { team } = await laneHeldByADepartedSeat();
        const { id: nodeId } = await localNodeForTeam(db, team.id);
        saveNodeEnrollment({
          team: team.slug,
          hub_url: 'http://hub.invalid:4849',
          node_id: nodeId,
          credential: 'msnode_test',
          enrolled_at: 1,
        });

        stop = startReaper(ctx);
        await vi.advanceTimersByTimeAsync(config.presenceTimeoutMs + config.reaperIntervalMs * 2);

        expect(await rerouted(team.id)).toHaveLength(0);
      } finally {
        delete process.env['MUSTERD_NODE_STATE'];
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('startReaper — a pulled lane whose acceptance window lapsed in silence (ADR 645 §4.4)', async () => {
    let db: Database;
    let hub: Hub;
    let config: ResolvedConfig;
    let ctx: Ctx;
    let stop: (() => void) | undefined;
    const WINDOW_MS = 20 * 60_000;

    beforeEach(async () => {
      vi.useFakeTimers();
      db = await openStore();
      hub = new Hub();
      config = resolveConfig();
      ctx = { db: db, hub, config, rosterRoots: [] };
    });

    afterEach(() => {
      stop?.();
      stop = undefined;
      vi.useRealTimers();
      db.close();
    });

    /** Kim (claude) pulled the lane; delta (claude, live, silent) holds the ask; Lin (gpt) is live. */
    async function pulledLaneAwaitingSilentHolder({ pulled = true, sweep = false } = {}) {
      const team = await createTeam(db, { slug: 'dawn' });
      if (sweep) await setPolicy(db, team.id, { loops: { sweep: true } });
      const worker = (await addMember(db, team, { name: 'Kim', kind: 'agent' })).row;
      const holder = (await addMember(db, team, { name: 'delta', kind: 'agent' })).row;
      const live = (await addMember(db, team, { name: 'Lin', kind: 'agent' })).row;
      const kim = await attach(db, worker.id, 'cli', 'conn-kim', { model: 'claude-opus-5' });
      const del = await attach(db, holder.id, 'cli', 'conn-delta', { model: 'claude-sonnet-5' });
      const lin = await attach(db, live.id, 'cli', 'conn-lin', { model: 'gpt-5.6-sol' });
      const lane = await openLane(db, team.id, team.slug, 'Kim', {
        title: 'pulled lane',
        claim: true,
      });
      if (pulled) {
        await appendAudit(db, team.id, {
          actor: 'Kim',
          action: 'lane.pulled',
          target: lane.id,
          result: 'allow',
          detail: { lane: lane.id, seat: 'Kim', host: 'mac', announcement: 'a', ask: 'pull-ask' },
        });
      }
      await updateLane(db, team.id, lane.id, team.slug, { state: 'awaiting_acceptance' });
      await appendAudit(db, team.id, {
        actor: 'Kim',
        action: 'lane.ready_for_review',
        target: lane.id,
        result: 'allow',
        detail: { lane: lane.id, owner: 'Kim', reviewer: 'delta', ask_timeout_ms: WINDOW_MS },
      });
      await insertMessage(
        db,
        team.id,
        worker.id,
        holder.id,
        makeEnvelope({
          id: 'ask-silent',
          team: team.slug,
          from: 'Kim',
          to: { kind: 'member', name: 'delta' },
          act: 'ask',
          body: '[lane] acceptance requested',
          meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
          ts: Date.now(),
        }),
      );
      return { team, lane, presences: [kim.id, del.id, lin.id] };
    }

    const heartbeat = async (presenceId: string) =>
      await db.run('UPDATE presence SET last_seen_at = ? WHERE id = ?', [Date.now(), presenceId]);

    async function liveFor(ms: number, presenceIds: string[]) {
      for (let t = 0; t < ms; t += config.reaperIntervalMs) {
        for (const id of presenceIds) await heartbeat(id);
        await vi.advanceTimersByTimeAsync(config.reaperIntervalMs);
      }
    }

    const rerouted = async (teamId: string) =>
      (await listAudit(db, teamId)).filter((r) => r.action === 'lane.review_rerouted');

    it('moves the ask once, after the window, to a live seat of another family', async () => {
      const { team, lane, presences } = await pulledLaneAwaitingSilentHolder();
      stop = startReaper(ctx);
      await liveFor(WINDOW_MS - config.reaperIntervalMs * 2, presences);
      expect(await rerouted(team.id)).toHaveLength(0);

      await liveFor(config.reaperIntervalMs * 4, presences);
      const rows = await rerouted(team.id);
      expect(rows).toHaveLength(1);
      const detail = JSON.parse(rows[0]!.detail as string);
      expect(detail).toMatchObject({
        lane: lane.id,
        from_reviewer: 'delta',
        superseded_ask: 'ask-silent',
        reviewer: 'Lin',
        route: 'lapsed',
        review_grade: 'cross_family',
      });
      expect((await getLane(db, team.id, lane.id, team.slug))!.state).toBe('awaiting_acceptance');

      // One move per submission, however long the second window runs in silence.
      await liveFor(WINDOW_MS * 2, presences);
      expect(await rerouted(team.id)).toHaveLength(1);
    });

    it('leaves a lane that was not pulled alone', async () => {
      const { team, presences } = await pulledLaneAwaitingSilentHolder({ pulled: false });
      stop = startReaper(ctx);
      await liveFor(WINDOW_MS + config.reaperIntervalMs * 4, presences);
      expect(await rerouted(team.id)).toHaveLength(0);
    });

    it('defers to the ADR 229 sweep when the team armed one', async () => {
      const { team, presences } = await pulledLaneAwaitingSilentHolder({ sweep: true });
      stop = startReaper(ctx);
      await liveFor(WINDOW_MS + config.reaperIntervalMs * 4, presences);
      expect(await rerouted(team.id)).toHaveLength(0);
    });

    it('is a hub decision: an enrolled joiner never moves it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'musterd-reaper-lapsed-'));
      process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
      try {
        const { team, presences } = await pulledLaneAwaitingSilentHolder();
        const { id: nodeId } = await localNodeForTeam(db, team.id);
        saveNodeEnrollment({
          team: team.slug,
          hub_url: 'http://hub.invalid:4849',
          node_id: nodeId,
          credential: 'msnode_test',
          enrolled_at: 1,
        });
        stop = startReaper(ctx);
        await liveFor(WINDOW_MS + config.reaperIntervalMs * 4, presences);
        expect(await rerouted(team.id)).toHaveLength(0);
      } finally {
        delete process.env['MUSTERD_NODE_STATE'];
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  /**
   * What only the hub decides. Which seat is gone, which incident nobody claimed, which acceptance
   * was abandoned are judgements about the WHOLE team, and an enrolled joiner holds a replica of it:
   * partial mid-drain, stale after a sleep, and blind to every seat that lives on another machine
   * (ADR 361 §1, ADR 371 §2). A joiner that makes them anyway writes hub-owned lane state from that
   * replica and sends messages AS seats bound to the hub, which the hub refuses `bound_elsewhere`
   * for good — the second-machine run wedged exactly that way on 2026-10-02 (see the guide's
   * Findings). Each sweep runs a hub case and a joiner case on the same fixture, so a fixture that
   * stops tripping the sweep fails the hub case instead of quietly passing the joiner one.
   */
  describe('startReaper — the decisions only the hub makes', async () => {
    let db: Database;
    let config: ResolvedConfig;
    let ctx: Ctx;
    let stop: (() => void) | undefined;
    let dir: string;

    beforeEach(async () => {
      vi.useFakeTimers();
      db = await openStore();
      config = resolveConfig();
      ctx = { db: db, hub: new Hub(), config, rosterRoots: [] };
      dir = mkdtempSync(join(tmpdir(), 'musterd-reaper-hubonly-'));
      process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
    });

    afterEach(() => {
      stop?.();
      stop = undefined;
      vi.useRealTimers();
      db.close();
      delete process.env['MUSTERD_NODE_STATE'];
      rmSync(dir, { recursive: true, force: true });
    });

    /** Leave this daemon enrolled as a joiner of `team`, the way `musterd node join` does. */
    async function enrolAsJoiner(team: TeamRow) {
      const { id } = await localNodeForTeam(db, team.id);
      saveNodeEnrollment({
        team: team.slug,
        hub_url: 'http://hub.invalid:4849',
        node_id: id,
        credential: 'msnode_test',
        enrolled_at: 1,
      });
    }

    /** Let the reaper tick past its listening window, so every sweep has had its turn. */
    async function reapOnce() {
      stop = startReaper(ctx);
      await vi.advanceTimersByTimeAsync(config.presenceTimeoutMs + config.reaperIntervalMs * 2);
    }

    const auditRows = async (teamId: string, action: string) =>
      (await listAudit(db, teamId)).filter((r) => r.action === action);

    describe('an incident nobody claimed (ADR 271)', async () => {
      async function unclaimedIncident(team: TeamRow) {
        for (const [name, role] of [
          ['izzo', 'reviewer'],
          ['dolly', 'reviewer'],
          ['stanley', 'platform'],
        ] as const) {
          await addMember(db, team, { name, kind: 'agent', role });
        }
        // Born well outside the claim window by the origin's clock — which is what a replayed
        // incident looks like to a joiner that folded its birth and not yet its claim.
        const at = Date.now() - 15 * 60_000;
        const gate = 'ci:gates/A11y contrast';
        await recordBlockedReport(db, team.id, team.slug, 'izzo', { gate }, 'm1', at);
        await recordBlockedReport(db, team.id, team.slug, 'dolly', { gate }, 'm2', at);
        const [lane] = await openIncidents(db, team.id, team.slug);
        expect(lane).toBeDefined();
        return lane!;
      }

      it('the hub hands it to the fallback role', async () => {
        const team = await createTeam(db, { slug: 'dawn' });
        const lane = await unclaimedIncident(team);

        await reapOnce();

        expect((await getLane(db, team.id, lane.id, team.slug))?.owner_seat).toBe('stanley');
        expect(await auditRows(team.id, 'incident.routed')).toHaveLength(1);
      });

      it('an enrolled joiner leaves it for the hub: no claim, no announcement', async () => {
        const team = await createTeam(db, { slug: 'dawn' });
        const lane = await unclaimedIncident(team);
        await enrolAsJoiner(team);

        await reapOnce();

        expect((await getLane(db, team.id, lane.id, team.slug))?.owner_seat).toBeNull();
        expect(await auditRows(team.id, 'incident.routed')).toHaveLength(0);
        expect(await auditRows(team.id, 'lane.claimed')).toHaveLength(0);
      });
    });

    describe('an acceptance past the backstop grace (ADR 229)', async () => {
      async function strandedAcceptance(team: TeamRow) {
        await addMember(db, team, { name: 'dolly', kind: 'agent' });
        const lane = await openLane(db, team.id, team.slug, 'dolly', {
          title: 'stranded',
          claim: true,
        });
        await updateLane(db, team.id, lane.id, team.slug, { state: 'awaiting_acceptance' });
        await db.run('UPDATE lanes SET updated_at = ? WHERE id = ?', [
          Date.now() - SWEEP_GRACE_MS - 60_000,
          lane.id,
        ]);
        await setPolicy(db, team.id, { loops: { sweep: true } });
        return lane;
      }

      it('the hub closes it, as the system', async () => {
        const team = await createTeam(db, { slug: 'dawn' });
        const lane = await strandedAcceptance(team);

        await reapOnce();

        expect((await getLane(db, team.id, lane.id, team.slug))?.state).toBe('done');
      });

      it('an enrolled joiner does not close it from a replica that may be a day stale', async () => {
        const team = await createTeam(db, { slug: 'dawn' });
        const lane = await strandedAcceptance(team);
        await enrolAsJoiner(team);

        await reapOnce();

        expect((await getLane(db, team.id, lane.id, team.slug))?.state).toBe('awaiting_acceptance');
        expect(await auditRows(team.id, 'lane.closed')).toHaveLength(0);
      });
    });

    describe('a lane still owned by a seat that left (ADR 196)', async () => {
      async function ghostLane(team: TeamRow) {
        const june = await addMember(db, team, { name: 'June', kind: 'agent' });
        const lane = await openLane(db, team.id, team.slug, 'June', {
          title: 'ghost wip',
          claim: true,
        });
        // Bypass leaveMember's own release — the historical ghost the sweep exists to clear.
        await db.run('UPDATE members SET left_at = ? WHERE id = ?', [Date.now(), june.row.id]);
        return lane;
      }

      it('the hub releases it', async () => {
        const team = await createTeam(db, { slug: 'dawn' });
        const lane = await ghostLane(team);

        await reapOnce();

        expect(await getLane(db, team.id, lane.id, team.slug)).toMatchObject({
          state: 'open',
          owner_seat: null,
        });
      });

      it('an enrolled joiner leaves it: the hub released it already, or will', async () => {
        const team = await createTeam(db, { slug: 'dawn' });
        const lane = await ghostLane(team);
        await enrolAsJoiner(team);

        await reapOnce();

        expect(await getLane(db, team.id, lane.id, team.slug)).toMatchObject({
          state: 'claimed',
          owner_seat: 'June',
        });
        expect(await auditRows(team.id, 'lane.released')).toHaveLength(0);
      });
    });
  });
});
