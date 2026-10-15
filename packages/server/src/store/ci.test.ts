import type { CiRunSample } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAudit } from './audit.js';
import { deriveCiTrend, recordCiRuns } from './ci.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('ci', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 20 * DAY;

  function run(over: Partial<CiRunSample> & { run_id: string }): CiRunSample {
    return {
      head_sha: 'abcdef1234567890',
      branch: 'main',
      event: 'push',
      attempt: 1,
      conclusion: 'success',
      created_at: NOW - DAY,
      duration_ms: 120_000,
      jobs: [
        { name: 'plan', conclusion: 'success', duration_ms: 6_000 },
        { name: 'docs', conclusion: 'success', duration_ms: 60_000 },
      ],
      ...over,
    };
  }

  describe('recordCiRuns (ADR 610)', () => {
    it('writes one ci.run_measured row per forge run id, however often it is sampled', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      expect(
        await recordCiRuns(db, team.id, 'autorefresh', [
          run({ run_id: '1' }),
          run({ run_id: '2' }),
        ]),
      ).toBe(2);
      // The next tick resends both and adds one.
      expect(
        await recordCiRuns(db, team.id, 'autorefresh', [
          run({ run_id: '1' }),
          run({ run_id: '2' }),
          run({ run_id: '3' }),
        ]),
      ).toBe(1);
      const rows = (await listAudit(db, team.id)).filter((a) => a.action === 'ci.run_measured');
      expect(rows.map((r) => r.target).sort()).toEqual(['1', '2', '3']);
      // Shapes only — the detail is the run's shape, the row's actor the sampling seat.
      expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ branch: 'main', duration_ms: 120_000 });
      expect(rows[0]!.actor).toBe('autorefresh');
    });
  });

  describe('deriveCiTrend (ADR 610)', () => {
    it('buckets by the run’s own time into this window and the previous, with p50/p90, red, flake and job p50s', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const thisWeek = NOW - 2 * DAY;
      const lastWeek = NOW - 9 * DAY;
      await recordCiRuns(db, team.id, 'autorefresh', [
        // This window: three green mains of 2/3/4 minutes and one red.
        run({ run_id: 'a', created_at: thisWeek, duration_ms: 120_000 }),
        run({ run_id: 'b', created_at: thisWeek + 1, duration_ms: 180_000 }),
        run({ run_id: 'c', created_at: thisWeek + 2, duration_ms: 240_000 }),
        run({
          run_id: 'd',
          created_at: thisWeek + 3,
          duration_ms: 300_000,
          conclusion: 'failure',
          event: 'schedule',
        }),
        // A cancelled main run is neither red nor green and never enters the percentiles.
        run({
          run_id: 'e',
          created_at: thisWeek + 4,
          duration_ms: 9_000_000,
          conclusion: 'cancelled',
        }),
        // PR SHA x: red then green on the same SHA — a flake. SHA y: red only — a real failure.
        // SHA z: green on attempt 2 — a re-run, counted as a flake.
        run({
          run_id: 'p1',
          created_at: thisWeek,
          event: 'pull_request',
          branch: 'feat/x',
          head_sha: 'x'.repeat(40),
          conclusion: 'failure',
        }),
        run({
          run_id: 'p2',
          created_at: thisWeek + 60_000,
          event: 'pull_request',
          branch: 'feat/x',
          head_sha: 'x'.repeat(40),
        }),
        run({
          run_id: 'p3',
          created_at: thisWeek,
          event: 'pull_request',
          branch: 'feat/y',
          head_sha: 'y'.repeat(40),
          conclusion: 'failure',
        }),
        run({
          run_id: 'p4',
          created_at: thisWeek,
          event: 'pull_request',
          branch: 'feat/z',
          head_sha: 'z'.repeat(40),
          attempt: 2,
        }),
        // Previous window: one slow green main.
        run({ run_id: 'old', created_at: lastWeek, duration_ms: 600_000 }),
        // Beyond both windows: ignored.
        run({ run_id: 'ancient', created_at: NOW - 30 * DAY, duration_ms: 1 }),
      ]);
      const trend = await deriveCiTrend(db, team.id, NOW);
      expect(trend.window_days).toBe(7);
      expect(trend.current).toMatchObject({
        main_runs: 5,
        main_p50_ms: 180_000,
        main_p90_ms: 300_000,
        main_red: 1,
        pr_shas: 3,
        pr_flaky: 2,
      });
      expect(trend.current.jobs[0]).toMatchObject({ name: 'docs', p50_ms: 60_000 });
      expect(trend.previous).toMatchObject({
        main_runs: 1,
        main_p50_ms: 600_000,
        main_red: 0,
        pr_shas: 0,
      });
      expect(trend.sampled_through).toBe(thisWeek + 60_000);
    });

    it('is empty, not absent, before anything is sampled', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const trend = await deriveCiTrend(db, team.id, NOW);
      expect(trend.current.main_runs).toBe(0);
      expect(trend.current.main_p50_ms).toBeNull();
      expect(trend.sampled_through).toBeNull();
    });
  });
});
