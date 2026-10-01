import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDb } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import {
  enrollResidency,
  HOST_STALE_MS,
  listHostSeen,
  recordHostSeen,
  recordSessionAttestation,
  seatWakeabilityFacts,
} from './residency.js';
import { teamFamilyPosture } from './review.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('residency.wakeability', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * Wakeability the roster can stand behind (ADR 357, lane 01M1J1KC6H).
   *
   * Until 2026-09-02 the roster's `wakeable` was `residency.has(member)` — enrolment, labelled as
   * reachability — and `wakeabilityFromFacts` (ADR 189) was called with two of its four facts:
   * nothing ever supplied `host_reachable` or `workspace_readable`, so `enrolled_host_stale` and
   * `enrolled_dead_workspace` could appear on a wake REPORT after the wake had already failed and
   * nowhere else. The host has been polling `POST /residency/wake-leases` every 10 s since ADR 131 —
   * a heartbeat the daemon received and never wrote down.
   */

  const TIMEOUT = 60_000;

  /** A wake-outcome audit row at an explicit `ts` — appendAudit stamps Date.now(), which cannot order two rows a test writes in the same millisecond. */
  async function wakeRow(
    db: ReturnType<typeof openDb>,
    teamId: string,
    action: 'residency.wake_failed' | 'residency.woke',
    target: string,
    detail: Record<string, unknown>,
    ts: number,
  ): Promise<void> {
    await db.run(
      `INSERT INTO audit (id, team_id, actor, action, target, result, detail, ts, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        `aud-${String(ts)}-${action}`,
        teamId,
        action,
        target,
        action === 'residency.woke' ? 'allow' : 'deny',
        JSON.stringify(detail),
        ts,
        ts,
      ],
    );
  }
  const NOW = 1_800_000_000_000;

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'dawn' });
    const agent = async (name: string) =>
      (await addMember(db, team, { kind: 'agent', name, role: '' })).row;
    const enrol = async (memberId: string, host = 'mac.lan') =>
      await enrollResidency(db, team.id, {
        member_id: memberId,
        harness: 'codex',
        host,
        grant_id: null,
        authorized_by: null,
      });
    return { db, team, agent, enrol };
  }

  describe('recordHostSeen / listHostSeen — the poll IS the heartbeat', async () => {
    it('records the newest sighting per (team, host) and reads it back', async () => {
      const { db, team } = await seed();
      expect((await listHostSeen(db, team.id)).size).toBe(0);
      await recordHostSeen(db, team.id, 'mac.lan', NOW - 5_000);
      await recordHostSeen(db, team.id, 'mac.lan', NOW);
      await recordHostSeen(db, team.id, 'fly-1', NOW - 90_000);
      expect(await listHostSeen(db, team.id)).toEqual(
        new Map([
          ['mac.lan', NOW],
          ['fly-1', NOW - 90_000],
        ]),
      );
    });

    it('never moves a sighting backwards — a late-arriving old poll must not make a host look stale', async () => {
      const { db, team } = await seed();
      await recordHostSeen(db, team.id, 'mac.lan', NOW);
      await recordHostSeen(db, team.id, 'mac.lan', NOW - 30_000);
      expect((await listHostSeen(db, team.id)).get('mac.lan')).toBe(NOW);
    });
  });

  describe('seatWakeabilityFacts — the facts wakeabilityFromFacts was always waiting for', async () => {
    it('an enrolled seat whose host polled inside HOST_STALE_MS is host_reachable', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordHostSeen(db, team.id, 'mac.lan', NOW - HOST_STALE_MS + 1);
      const facts = (await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id);
      expect(facts).toMatchObject({
        enrolled: true,
        host_reachable: true,
        workspace_readable: true,
      });
    });

    it('an enrolled seat whose host has not polled for HOST_STALE_MS is NOT host_reachable', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordHostSeen(db, team.id, 'mac.lan', NOW - HOST_STALE_MS);
      expect((await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.host_reachable).toBe(
        false,
      );
    });

    it('an enrolled seat whose host has NEVER polled is UNKNOWN, not stale — absence is not an assertion (ADR 236)', async () => {
      // A fresh install, an older host build, or a registry entry nobody has polled for yet must
      // read exactly as they did before host_liveness existed. Only an observed silence — a host that
      // polled and then stopped — is stale. The first mutation of this rule ("never seen ⇒ stale")
      // turned five existing wake-pool tests red, which is the right thing for them to have done.
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      expect(
        (await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.host_reachable,
      ).toBeUndefined();
    });

    it('the last wake report saying enrolled_dead_workspace makes the seat not workspace_readable — until a later woke', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordHostSeen(db, team.id, 'mac.lan', NOW);
      await wakeRow(
        db,
        team.id,
        'residency.wake_failed',
        'gptbot',
        { lease_id: 'L1', wakeability: 'enrolled_dead_workspace', reason: 'workspace gone' },
        NOW - 60_000,
      );
      expect((await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.workspace_readable).toBe(
        false,
      );
      await wakeRow(db, team.id, 'residency.woke', 'gptbot', { lease_id: 'L2' }, NOW - 30_000);
      expect((await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.workspace_readable).toBe(
        true,
      );
    });

    it('a wake_failed for any OTHER reason leaves workspace_readable true — only the still-true set sticks', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordHostSeen(db, team.id, 'mac.lan', NOW);
      await wakeRow(
        db,
        team.id,
        'residency.wake_failed',
        'gptbot',
        { lease_id: 'L1', wakeability: 'wakeable', reason: 'watchdog timeout' },
        NOW - 60_000,
      );
      expect((await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.workspace_readable).toBe(
        true,
      );
    });

    it('an unenrolled seat has no entry', async () => {
      const { db, team, agent } = await seed();
      const bot = await agent('ghost');
      expect((await seatWakeabilityFacts(db, team.id, NOW)).has(bot.id)).toBe(false);
    });
  });

  describe('teamFamilyPosture — the ADR 191 wake pool now sees host and workspace', async () => {
    it('an enrolled idle seat on a stale host is enrolled_host_stale, not wakeable', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordHostSeen(db, team.id, 'mac.lan', Date.now() - HOST_STALE_MS - 1);
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.wake_pool.find((c) => c.seat === 'gptbot')?.wakeability).toBe('enrolled_host_stale');
    });

    it('an enrolled idle seat on a host this daemon has never heard from is still wakeable — unknown never demotes', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.wake_pool.find((c) => c.seat === 'gptbot')?.wakeability).toBe('wakeable');
    });

    it('an enrolled idle seat on a live host with a readable workspace is wakeable', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordHostSeen(db, team.id, 'mac.lan', Date.now());
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.wake_pool.find((c) => c.seat === 'gptbot')?.wakeability).toBe('wakeable');
    });

    it('a dead workspace outranks a live host — the ADR 189 ladder order', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordHostSeen(db, team.id, 'mac.lan', Date.now());
      await wakeRow(
        db,
        team.id,
        'residency.wake_failed',
        'gptbot',
        { lease_id: 'L1', wakeability: 'enrolled_dead_workspace', reason: 'workspace gone' },
        Date.now() - 1_000,
      );
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.wake_pool.find((c) => c.seat === 'gptbot')?.wakeability).toBe(
        'enrolled_dead_workspace',
      );
    });
  });

  describe('seatWakeabilityFacts — the resumable badge is withdrawn by a fresh wake (ADR 424)', async () => {
    const CAPTURE = NOW - 3_600_000;

    it('a capture with no wake since keeps its attestation time', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordSessionAttestation(db, team.id, bot.id, 'claude-code', CAPTURE);
      expect((await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.resumable_at).toBe(
        CAPTURE,
      );
    });

    it('a fresh wake AFTER the capture withdraws it — the roster stops promising a resume the ladder refused', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordSessionAttestation(db, team.id, bot.id, 'claude-code', CAPTURE);
      await wakeRow(
        db,
        team.id,
        'residency.woke',
        'gptbot',
        { session: 'fresh' },
        CAPTURE + 60_000,
      );
      expect((await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.resumable_at).toBeNull();
    });

    it('a resumed wake after the capture leaves it standing', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordSessionAttestation(db, team.id, bot.id, 'claude-code', CAPTURE);
      await wakeRow(
        db,
        team.id,
        'residency.woke',
        'gptbot',
        { session: 'resumed' },
        CAPTURE + 60_000,
      );
      expect((await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.resumable_at).toBe(
        CAPTURE,
      );
    });

    it('a fresh wake BEFORE the capture is not evidence against it — a new capture re-arms the badge', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await wakeRow(
        db,
        team.id,
        'residency.woke',
        'gptbot',
        { session: 'fresh' },
        CAPTURE - 60_000,
      );
      await recordSessionAttestation(db, team.id, bot.id, 'claude-code', CAPTURE);
      expect((await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.resumable_at).toBe(
        CAPTURE,
      );
    });

    it('a woke row without a session axis is not evidence of anything (ADR 236)', async () => {
      const { db, team, agent, enrol } = await seed();
      const bot = await agent('gptbot');
      await enrol(bot.id);
      await recordSessionAttestation(db, team.id, bot.id, 'claude-code', CAPTURE);
      await wakeRow(db, team.id, 'residency.woke', 'gptbot', { act: 'a1' }, CAPTURE + 60_000);
      expect((await seatWakeabilityFacts(db, team.id, NOW)).get(bot.id)?.resumable_at).toBe(
        CAPTURE,
      );
    });
  });
});
