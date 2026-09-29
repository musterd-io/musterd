import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUERY_NAMES, runBench, toPgPlaceholders } from './pglite-hookpath.mjs';

describe('pglite hook-path bench', () => {
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
    }
  }, 120_000);

  it("a literal '?' is not a placeholder", () => {
    expect(toPgPlaceholders("SELECT 'why?' AS s WHERE ? = ? AND t = 'a?b'")).toBe(
      "SELECT 'why?' AS s WHERE $1 = $2 AND t = 'a?b'",
    );
  });
});

describe('indexJson option', () => {
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
