import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { museCandidates, resolveMuseBin } from './museBin.js';

const ok = () => Promise.resolve({ ok: true });
const miss = () => Promise.resolve({ ok: false });

describe('resolveMuseBin (ADR 619)', () => {
  it('prefers the bare `muse` on PATH — the name is unambiguous', async () => {
    await expect(resolveMuseBin(ok, '/nonexistent-home')).resolves.toBe('muse');
  });

  it('falls back to a candidate file when PATH misses', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muse-bin-test-'));
    try {
      const bin = join(home, '.local', 'bin', 'muse');
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(bin, '#!/bin/sh\necho muse\n');
      chmodSync(bin, 0o755);
      const runnable = (cmd: string) => Promise.resolve({ ok: cmd === bin });
      await expect(resolveMuseBin(runnable, home)).resolves.toBe(bin);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns null when nothing resolves', async () => {
    await expect(resolveMuseBin(miss, '/nonexistent-home')).resolves.toBe(null);
  });

  it('candidates start at the official installer default', () => {
    const c = museCandidates('/home/u');
    expect(c[0]).toBe('/home/u/.local/bin/muse');
    expect(c).toHaveLength(3);
  });
});
