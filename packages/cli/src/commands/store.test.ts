import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { storeCommand } from './store.js';

describe('store command (ADR 478)', () => {
  let daemon: RunningServer;
  let dir: string;

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  beforeEach(async () => {
    daemon = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await daemon.listen();
    dir = mkdtempSync(join(tmpdir(), 'musterd-store-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

  it('prune --dry-run prints the count and the sizes, and prunes nothing', async () => {
    const { code, out } = await capture(() => storeCommand(parseArgs(['prune', '--dry-run'])));
    expect(code).toBe(0);
    expect(out).toContain('dry run — nothing pruned');
    expect(out).toContain('audit churn prunable now: 0 rows');
    expect(out).toContain('none (in-memory store)');
  });

  it('compact surfaces the daemon refusal as the command error', async () => {
    await expect(capture(() => storeCommand(parseArgs(['compact'])))).rejects.toThrow(/in memory/);
  });

  it('archive ls says when there is no archive yet', async () => {
    const { code, out } = await capture(() => storeCommand(parseArgs(['archive', 'ls'])));
    expect(code).toBe(0);
    expect(out).toContain('no archive yet');
  });

  it('anything else is usage', async () => {
    await expect(storeCommand(parseArgs(['nope']))).rejects.toThrow(/usage/);
  });
});
