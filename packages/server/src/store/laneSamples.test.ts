import type { MetricInput } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAudit } from './audit.js';
import { getLane, openLane, updateLane } from './lanes.js';
import { recordSample } from './laneSamples.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

const metric = {
  name: 'hit rate',
  unit: '%',
  baseline: 40,
  target: 60,
  direction: 'up',
  source: 'manual',
} as const satisfies MetricInput;

/** ADR 673: a dated read's metric, its daily samples, and a verdict that carries the number. */
withDrivers('lane samples', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function measured(extra: Record<string, unknown> = {}) {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'bravo' });
    const lane = await openLane(db, team.id, team.slug, 'nick', {
      title: 'does ranking help',
      reads_on: '2026-10-21',
      metric,
      ...extra,
    });
    return { db, team, lane };
  }

  describe('metric', () => {
    it('is stamped with who set it, and refused without a read day', async () => {
      const { lane } = await measured();
      expect(lane.metric).toMatchObject({ ...metric, by: 'nick' });
      const db = await openStore();
      const team = await createTeam(db, { slug: 'charlie' });
      await expect(
        openLane(db, team.id, team.slug, 'nick', { title: 'undated', metric }),
      ).rejects.toThrow(/reads_on/);
    });

    it('cannot outlive its read day, and a moved target is on the record', async () => {
      const { db, team, lane } = await measured();
      const audit = { actor: 'nick' };
      await expect(
        updateLane(db, team.id, lane.id, team.slug, { reads_on: null }, 2, undefined, audit),
      ).rejects.toThrow(/clear the metric/);
      await updateLane(
        db,
        team.id,
        lane.id,
        team.slug,
        { metric: { ...metric, target: 50 } },
        3,
        undefined,
        audit,
      );
      const moved = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'lane.metric_changed',
      );
      expect(JSON.parse(String(moved[0]?.detail))).toMatchObject({
        from: { target: 60 },
        to: { target: 50 },
      });
      const cleared = await updateLane(
        db,
        team.id,
        lane.id,
        team.slug,
        { metric: null, reads_on: null },
        4,
        undefined,
        audit,
      );
      expect(cleared?.metric).toBeUndefined();
    });
  });

  describe('samples', () => {
    it('replace their day, record what they replaced, and ride the lane oldest first', async () => {
      const { db, team, lane } = await measured();
      await recordSample(db, team.id, lane, { day: '2026-10-19', value: 50, n: 10 }, 'nick', 1);
      await recordSample(db, team.id, lane, { day: '2026-10-18', value: 45, n: 8 }, 'nick', 2);
      const second = await recordSample(
        db,
        team.id,
        lane,
        { day: '2026-10-19', value: 61, n: 23 },
        'ada',
        3,
      );
      expect(second.replaced).toMatchObject({ value: 50, n: 10, by: 'nick' });
      const got = await getLane(db, team.id, lane.id, team.slug);
      expect(got?.samples?.map((s) => [s.day, s.value])).toEqual([
        ['2026-10-18', 45],
        ['2026-10-19', 61],
      ]);
      const rows = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'lane.sample_recorded',
      );
      expect(rows).toHaveLength(3);
    });

    it('serves at most the newest 60 days', async () => {
      const { db, team, lane } = await measured();
      for (let i = 1; i <= 62; i++) {
        const day = new Date(Date.UTC(2026, 7, i)).toISOString().slice(0, 10);
        await recordSample(db, team.id, lane, { day, value: i, n: 1 }, 'nick', i);
      }
      const got = await getLane(db, team.id, lane.id, team.slug);
      expect(got?.samples).toHaveLength(60);
      expect(got?.samples?.[0]?.value).toBe(3);
      expect(got?.samples?.at(-1)?.value).toBe(62);
    });

    it('are refused on a lane with no metric, and on a closed one', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'delta' });
      const plain = await openLane(db, team.id, team.slug, 'nick', { title: 'no metric' });
      await expect(
        recordSample(db, team.id, plain, { day: '2026-10-19', value: 1, n: 1 }, 'nick'),
      ).rejects.toThrow(/no metric/);
      const { lane } = await measured();
      await expect(
        recordSample(
          db,
          team.id,
          { ...lane, state: 'done' },
          { day: '2026-10-19', value: 1, n: 1 },
          'nick',
        ),
      ).rejects.toThrow(/takes no samples/);
    });

    it('stay off a lane with no metric', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'echo' });
      const plain = await openLane(db, team.id, team.slug, 'nick', { title: 'no metric' });
      expect((await getLane(db, team.id, plain.id, team.slug))?.samples).toBeUndefined();
    });
  });

  describe('verdict', () => {
    it('met or missed on a metric lane needs measured; inconclusive does not', async () => {
      const { db, team, lane } = await measured();
      const audit = { actor: 'nick' };
      const verdict = (v: Record<string, unknown>) =>
        updateLane(
          db,
          team.id,
          lane.id,
          team.slug,
          { read_verdict: { note: 'read it', ...v } as never },
          5,
          undefined,
          audit,
        );
      await expect(verdict({ outcome: 'met' })).rejects.toThrow(/give measured/);
      const met = await verdict({
        outcome: 'met',
        measured: { value: 61, n: 23 },
        evidence: 'scripts/research/next-readout.ts',
      });
      expect(met?.read_verdict).toMatchObject({ measured: { value: 61, n: 23 }, by: 'nick' });
      const recorded = (await listAudit(db, team.id)).find(
        (r) => r.action === 'lane.read_recorded',
      );
      expect(JSON.parse(String(recorded?.detail))).toMatchObject({
        measured: { value: 61, n: 23 },
      });
      const inconclusive = await verdict({ outcome: 'inconclusive' });
      expect(inconclusive?.read_verdict?.outcome).toBe('inconclusive');
    });
  });
});
