import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPicker } from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-picker-index-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('openPicker (ADR 491)', () => {
  it('the paint probe prints the first frame and the time, without a TTY', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await openPicker({
        env: { MUSTERD_CONFIG: join(dir, 'config.json'), MUSTERD_PAINT_PROBE: '1' },
        home: dir,
      });
      expect(code).toBe(0);
      expect(String(out.mock.calls[0]?.[0])).toContain('musterd');
      expect(String(err.mock.calls[0]?.[0])).toMatch(/^first-paint \d+(\.\d+)?ms\n$/);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
