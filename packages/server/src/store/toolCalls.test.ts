import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAudit } from './audit.js';
import { createTeam } from './teams.js';
import {
  deriveToolCallMetrics,
  recordAdapterStartup,
  recordSurfaceRender,
  recordToolCalls,
} from './toolCalls.js';

let openStore: () => Promise<Driver>;

withDrivers('toolCalls', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    return { db, team };
  }

  const HOUR = 60 * 60 * 1000;

  describe('the rail (ADR 640)', async () => {
    const send = (calls: number, total: number, max: number) => [
      {
        tool: 'team_send',
        outcome: 'ok' as const,
        calls,
        total_duration_ms: total,
        max_duration_ms: max,
      },
    ];

    it('defaults to stdio, and the report adds no split for a single rail', async () => {
      const { db, team } = await seed();
      const now = Date.now();
      await recordToolCalls(db, team.id, 'ada', null, send(2, 40, 30), now);
      const rows = await db.all<{ rail: string }>('SELECT rail FROM tool_call_stats');
      expect(rows.map((r) => r.rail)).toEqual(['stdio']);
      const row = (await deriveToolCallMetrics(db, team.id, now)).tools[0]!;
      expect(row.calls).toBe(2);
      expect(row.by_rail).toBeUndefined();
    });

    it("keeps one seat's remote and stdio calls apart and splits them in the report", async () => {
      const { db, team } = await seed();
      const now = Date.now();
      await recordToolCalls(db, team.id, 'nick', null, send(3, 30, 20), now, 'stdio');
      await recordToolCalls(db, team.id, 'nick', null, send(2, 400, 300), now, 'remote');
      expect(
        (await db.all('SELECT rail FROM tool_call_stats ORDER BY rail')).map(
          (r: { rail: string }) => r.rail,
        ),
      ).toEqual(['remote', 'stdio']);
      const row = (await deriveToolCallMetrics(db, team.id, now)).tools[0]!;
      expect(row.calls).toBe(5);
      expect(row.by_rail).toEqual({
        stdio: { calls: 3, avg_duration_ms: 10, max_duration_ms: 20 },
        remote: { calls: 2, avg_duration_ms: 200, max_duration_ms: 300 },
      });
    });
  });

  describe('recordToolCalls (ADR 144 inc 1 — the hourly aggregate)', async () => {
    it('upserts into one row per (seat, tool, outcome, hour) — never one row per call', async () => {
      const { db, team } = await seed();
      const now = 10 * HOUR + 5;
      await recordToolCalls(
        db,
        team.id,
        'ada',
        'backend',
        [
          {
            tool: 'team_send',
            outcome: 'ok',
            calls: 3,
            total_duration_ms: 300,
            max_duration_ms: 200,
          },
        ],
        now,
      );
      // A second flush in the same hour folds in: calls add, durations add, max keeps the max.
      await recordToolCalls(
        db,
        team.id,
        'ada',
        'backend',
        [
          {
            tool: 'team_send',
            outcome: 'ok',
            calls: 2,
            total_duration_ms: 500,
            max_duration_ms: 450,
          },
        ],
        now + 60_000,
      );
      const rows = (await db.all('SELECT * FROM tool_call_stats')) as {
        calls: number;
        total_duration_ms: number;
        max_duration_ms: number;
        bucket_start: number;
        role: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.calls).toBe(5);
      expect(rows[0]!.total_duration_ms).toBe(800);
      expect(rows[0]!.max_duration_ms).toBe(450);
      expect(rows[0]!.bucket_start).toBe(10 * HOUR);
      expect(rows[0]!.role).toBe('backend');
      // The next hour starts a new bucket.
      await recordToolCalls(
        db,
        team.id,
        'ada',
        'backend',
        [
          {
            tool: 'team_send',
            outcome: 'ok',
            calls: 1,
            total_duration_ms: 10,
            max_duration_ms: 10,
          },
        ],
        now + HOUR,
      );
      expect(await db.get('SELECT COUNT(*) AS n FROM tool_call_stats')).toEqual({ n: 2 });
    });

    it('a later flush with a role fills in a previously-unroled row (last write wins, never null-clobbers)', async () => {
      const { db, team } = await seed();
      const now = 10 * HOUR;
      const e = [
        {
          tool: 'team_status',
          outcome: 'ok' as const,
          calls: 1,
          total_duration_ms: 5,
          max_duration_ms: 5,
        },
      ];
      await recordToolCalls(db, team.id, 'ada', 'backend', e, now);
      await recordToolCalls(db, team.id, 'ada', null, e, now + 1);
      const row = (await db.get('SELECT role FROM tool_call_stats')) as { role: string | null };
      expect(row.role).toBe('backend');
    });
  });

  describe('deriveToolCallMetrics', async () => {
    it('aggregates per tool across seats/outcomes with bounce rate, latency, and the role split', async () => {
      const { db, team } = await seed();
      const now = 100 * HOUR;
      await recordToolCalls(
        db,
        team.id,
        'ada',
        'backend',
        [
          {
            tool: 'team_send',
            outcome: 'ok',
            calls: 8,
            total_duration_ms: 800,
            max_duration_ms: 300,
          },
          {
            tool: 'team_send',
            outcome: 'invalid_input',
            calls: 2,
            total_duration_ms: 20,
            max_duration_ms: 15,
          },
        ],
        now - HOUR,
      );
      await recordToolCalls(
        db,
        team.id,
        'billie',
        null,
        [
          {
            tool: 'team_send',
            outcome: 'error',
            calls: 1,
            total_duration_ms: 50,
            max_duration_ms: 50,
          },
        ],
        now - HOUR,
      );
      const m = await deriveToolCallMetrics(db, team.id, now);
      expect(m.calls).toBe(11);
      expect(m.bounces).toBe(2);
      expect(m.tools).toHaveLength(1);
      const send = m.tools[0]!;
      expect(send.tool).toBe('team_send');
      expect(send.calls).toBe(11);
      expect(send.errors).toBe(1);
      expect(send.bounces).toBe(2);
      expect(send.bounce_rate).toBeCloseTo(2 / 11);
      expect(send.avg_duration_ms).toBe(Math.round(870 / 11));
      expect(send.max_duration_ms).toBe(300);
      expect(send.by_role).toEqual({ backend: 10, unroled: 1 });
    });

    it('windows the counters to 7d but keeps the newest surface attestation per seat regardless', async () => {
      const { db, team } = await seed();
      const now = 1000 * HOUR;
      await recordToolCalls(
        db,
        team.id,
        'ada',
        null,
        [
          {
            tool: 'team_status',
            outcome: 'ok',
            calls: 4,
            total_duration_ms: 4,
            max_duration_ms: 1,
          },
        ],
        now - 8 * 24 * HOUR, // outside the window
      );
      await recordSurfaceRender(db, team.id, 'ada', {
        tools: 18,
        bytes: 40_000,
        est_tokens: 10_000,
      });
      const m = await deriveToolCallMetrics(db, team.id, now);
      expect(m.calls).toBe(0);
      expect(m.tools).toHaveLength(0);
      expect(m.surface).toHaveLength(1);
      expect(m.surface[0]).toMatchObject({
        seat: 'ada',
        tools: 18,
        bytes: 40_000,
        est_tokens: 10_000,
      });
    });

    it('surface attestations land append-only in the audit ledger; the newest per seat wins', async () => {
      const { db, team } = await seed();
      await recordSurfaceRender(db, team.id, 'ada', {
        tools: 18,
        bytes: 40_000,
        est_tokens: 10_000,
        breakdown: [{ tool: 'team_send', bytes: 2_000, description_bytes: 1_700 }],
      });
      // Audit rows are stamped Date.now(); step past the ms so "newest" is unambiguous (ulid ids
      // don't order within one tick).
      await new Promise((r) => setTimeout(r, 2));
      await recordSurfaceRender(db, team.id, 'ada', {
        tools: 18,
        bytes: 30_000,
        est_tokens: 7_500,
      });
      const rows = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'mcp.surface_rendered',
      );
      expect(rows).toHaveLength(2); // append-only: the history IS the before/after
      const m = await deriveToolCallMetrics(db, team.id);
      expect(m.surface).toHaveLength(1);
      expect(m.surface[0]!.bytes).toBe(30_000);
    });
  });

  describe('adapter startup (ADR 584)', async () => {
    it('keeps one row per launch and reports nearest-rank p50/p90 per harness', async () => {
      const { db, team } = await seed();
      for (const ms of [300, 320, 340, 360, 380, 400, 420, 440, 460, 900]) {
        await recordAdapterStartup(db, team.id, 'ada', {
          surface: 'claude-code',
          initialize_ms: ms - 20,
          tools_list_ms: ms,
        });
      }
      await recordAdapterStartup(db, team.id, 'bea', {
        surface: 'grok',
        initialize_ms: null,
        tools_list_ms: 250,
      });
      const rows = (await listAudit(db, team.id)).filter(
        (a) => a.action === 'mcp.startup_measured',
      );
      expect(rows).toHaveLength(11);

      const { startup } = await deriveToolCallMetrics(db, team.id);
      expect(startup).toEqual([
        {
          surface: 'claude-code',
          launches: 10,
          initialize_p50_ms: 360,
          initialize_p90_ms: 440,
          tools_list_p50_ms: 380,
          tools_list_p90_ms: 460,
        },
        {
          surface: 'grok',
          launches: 1,
          initialize_p50_ms: null,
          initialize_p90_ms: null,
          tools_list_p50_ms: 250,
          tools_list_p90_ms: 250,
        },
      ]);
    });
  });
});
