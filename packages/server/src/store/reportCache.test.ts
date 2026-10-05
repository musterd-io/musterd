import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Report } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDriver } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { deriveReport } from './insights.js';
import { createReportCache, createReportService } from './reportCache.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('reportCache', (o, kind) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  const fake = (n: number) => ({ team: `t${n}` }) as unknown as Report;

  async function harness(opts: { ttlMs?: number; maxStaleMs?: number } = {}) {
    let t = 1_000;
    let calls = 0;
    let release: (() => void) | undefined;
    const cache = createReportCache(
      () => {
        calls++;
        const n = calls;
        return new Promise<Report>((resolve) => {
          release = () => resolve(fake(n));
        });
      },
      { ...opts, now: () => t },
    );
    return {
      cache,
      calls: () => calls,
      release: () => release?.(),
      advance: (ms: number) => (t += ms),
    };
  }

  describe('report cache policy', () => {
    it('concurrent readers share one derivation (single flight)', async () => {
      const h = await harness();
      const a = h.cache.get('team', 'revive');
      const b = h.cache.get('team', 'revive');
      h.release();
      expect(await a).toBe(await b);
      expect(h.calls()).toBe(1);
    });

    it('serves the cached report inside the TTL without deriving again', async () => {
      const h = await harness({ ttlMs: 5_000 });
      const first = h.cache.get('team', 'revive');
      h.release();
      await first;
      h.advance(4_999);
      expect((await h.cache.get('team', 'revive')).team).toBe('t1');
      expect(h.calls()).toBe(1);
    });

    it('past the TTL serves stale at once and refreshes once in the background', async () => {
      const h = await harness({ ttlMs: 5_000, maxStaleMs: 60_000 });
      const first = h.cache.get('team', 'revive');
      h.release();
      await first;
      h.advance(6_000);
      expect((await h.cache.get('team', 'revive')).team).toBe('t1');
      expect((await h.cache.get('team', 'revive')).team).toBe('t1');
      expect(h.calls()).toBe(2); // one refresh, not one per reader
      h.release();
      await new Promise((r) => setImmediate(r));
      expect((await h.cache.get('team', 'revive')).team).toBe('t2');
    });

    it('past max staleness the reader waits for the fresh report', async () => {
      const h = await harness({ ttlMs: 5_000, maxStaleMs: 60_000 });
      const first = h.cache.get('team', 'revive');
      h.release();
      await first;
      h.advance(61_000);
      const next = h.cache.get('team', 'revive');
      h.release();
      expect((await next).team).toBe('t2');
    });

    it('a failed derivation is not cached — the next reader retries', async () => {
      let calls = 0;
      const cache = createReportCache(async () => {
        calls++;
        return calls === 1
          ? await Promise.reject(new Error('boom'))
          : await Promise.resolve(fake(calls));
      });
      await expect(cache.get('team', 'revive')).rejects.toThrow('boom');
      expect((await cache.get('team', 'revive')).team).toBe('t2');
    });

    it('keys by team', async () => {
      let calls = 0;
      const cache = createReportCache(() => Promise.resolve(fake(++calls)));
      await cache.get('a', 'a');
      await cache.get('b', 'b');
      expect(calls).toBe(2);
    });
  });

  describe('report service', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('an in-memory store derives inline, uncached (the pre-worker behavior)', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const svc = createReportService(db, 120_000);
      const report = await svc.get(team.id, team.slug);
      expect(report.team).toBe('revive');
      await svc.close();
    });

    it('the cached inline (Cloud) derivation runs in one transaction under the scoped handle', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const scope = db.forTeam(team.id);
      const tx = vi.spyOn(scope, 'tx');
      const svc = createReportService(db, 120_000, { cacheInline: true });
      const report = await svc.get(team.id, team.slug, scope);
      expect(report.team).toBe('revive');
      expect(tx).toHaveBeenCalledTimes(1);
      await svc.close();
    });

    // The worker entry is `reportWorker.js` beside the compiled module, so this runs against the build
    // (`gates` builds before it tests). Without a build there is no worker to spawn.
    const built = existsSync(new URL('../../dist/store/reportWorker.js', import.meta.url));
    // The worker opens the store BY PATH: a SQLite property (the Postgres service derives inline).
    it.runIf(built && kind === 'sqlite')(
      'a file-backed store derives in the worker, matching the inline report',
      async () => {
        dir = mkdtempSync(join(tmpdir(), 'musterd-report-'));
        const db = openDriver(join(dir, 'musterd.db'));
        const team = await createTeam(db, { slug: 'revive' });
        const mod = (await import(
          new URL('../../dist/store/reportCache.js', import.meta.url).href
        )) as typeof import('./reportCache.js');
        const svc = mod.createReportService(db, 120_000);
        const report = await svc.get(team.id, team.slug);
        const inline = await deriveReport(db, team.id, team.slug, report.generated_ts, 120_000);
        // family_posture stamps its own wall clock; everything else is a function of `now`.
        const strip = (r: Report) => ({ ...r, family_posture: undefined });
        expect(strip(report)).toEqual(strip(inline));
        expect(report.family_posture?.state).toBe(inline.family_posture?.state);
        await svc.close();
        await db.close();
      },
    );
  });
});
