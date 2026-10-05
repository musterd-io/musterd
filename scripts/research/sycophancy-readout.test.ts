import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLedger } from './sycophancy-readout.js';

/**
 * The dispute definitions and their tests live in `@musterd/protocol` (`sycophancy.ts`, ADR 481 /
 * ADR 505). This file guards the one half only the script computes: the ledger read.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function entries(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const entry = (claimed: string, falsified: string, passedBy = '') =>
  `---\nclaim: "x"\nclaimed_at: ${claimed}\nfalsified_at: ${falsified}\n${passedBy}status: falsified\n---\nbody\n`;

describe('readLedger', () => {
  it('counts entries falsified in the window, those carrying passed_by, and the mean days stood', () => {
    const dir = entries({
      'a.md': entry('2026-10-01', '2026-10-05', 'passed_by:\n  - acceptance: ask 01M\n'),
      'b.md': entry('2026-09-20', '2026-10-02'),
      'old.md': entry('2026-08-01', '2026-08-21', 'passed_by: []\n'),
    });
    expect(readLedger(dir, Date.parse('2026-10-01'))).toEqual({
      entries: 2,
      with_passed_by: 1,
      mean_latency_days: 8, // (4 + 12) / 2
    });
  });

  it('a missing directory reads as nothing, not as an error', () => {
    expect(readLedger('/nonexistent/claims', 0)).toEqual({
      entries: 0,
      with_passed_by: 0,
      mean_latency_days: null,
    });
  });
});
