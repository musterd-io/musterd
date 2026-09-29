import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUERY_NAMES, runBench, toPgPlaceholders } from './pglite-hookpath.mjs';

// Spike-only: 9 PGlite boots + seeding per run is minutes on a loaded CI box (review I6).
const spike = process.env.PGLITE_SPIKE ? describe : describe.skip;

spike('pglite hook-path bench', () => {
  it('produces a full report for each backend at a tiny scale, with a warm-up round discarded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-'));
    for (const backend of ['sqlite', 'pglite-memory', 'pglite-file'] as const) {
      const r = await runBench({ backend, dir: join(dir, backend), scale: 0.001, rounds: 3 });
      expect(r.backend).toBe(backend);
      expect(r.boot_ms).toBeGreaterThan(0);
      expect(r.rows.messages).toBeGreaterThan(0);
      for (const q of QUERY_NAMES) {
        const stats = r.queries[q];
        expect(stats).toBeDefined();
        expect(stats?.n).toBe(3); // rounds counted; the warm-up round is not
        expect(stats?.p95).toBeGreaterThanOrEqual(stats?.p50 ?? Infinity);
      }
      expect(r.write_commit_ms.p50).toBeGreaterThan(0);
      // C1: boot on a fresh directory is creation; the daemon's real start is a REOPEN.
      if (backend === 'pglite-file') expect(r.reopen_ms).toBeGreaterThan(0);
      else expect(r.reopen_ms).toBeNull();
      expect(r.analyzed).toBe(true);
    }
  }, 180_000);

  it("a literal '?' is not a placeholder", () => {
    expect(toPgPlaceholders("SELECT 'why?' AS s WHERE ? = ? AND t = 'a?b'")).toBe(
      "SELECT 'why?' AS s WHERE $1 = $2 AND t = 'a?b'",
    );
  });
});

spike('indexJson option', () => {
  it('adds the json expression index and says so in the report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-'));
    const r = await runBench({
      backend: 'pglite-memory',
      dir,
      scale: 0.001,
      rounds: 1,
      indexJson: true,
    });
    expect(r.indexJson).toBe(true);
  }, 60_000);
});
