import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { dreamCommand } from './dream.js';
import { teamCommand } from './team.js';

describe('dream command (goal dreaming, lane 2)', () => {
  let server: RunningServer;
  let dir: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    previousEnv = {
      MUSTERD_SERVER: process.env['MUSTERD_SERVER'],
      MUSTERD_CONFIG: process.env['MUSTERD_CONFIG'],
      MUSTERD_NO_NUDGE: process.env['MUSTERD_NO_NUDGE'],
    };
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-dream-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_NUDGE'] = '1';
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function capture(fn: () => Promise<number>): Promise<string> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: never) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await fn();
      return chunks.join('');
    } finally {
      spy.mockRestore();
    }
  }

  it("prints the caller's own packet as JSON and rejects a non-numeric --since", async () => {
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
    const out = await capture(() => dreamCommand(parseArgs(['--since', '0'])));
    const built = JSON.parse(out);
    expect(built).toMatchObject({ packet: { seat: 'nick', since: 0 }, truncated: false });
    expect(built.used_bytes).toBeGreaterThan(0);
    await expect(dreamCommand(parseArgs(['--since', 'yesterday']))).rejects.toThrow(
      /--since <epoch-ms>/,
    );
  });
});
