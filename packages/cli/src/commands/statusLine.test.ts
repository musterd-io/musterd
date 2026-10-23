import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { statusLineCommand } from './statusLine.js';
import { teamCommand } from './team.js';

describe('status-line command (ADR 721)', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-status-line-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

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

  // `team create` auto-binds the cwd identity (ADR 036), so the command resolves `nick` from the
  // binding without an explicit --as.
  async function setupTeam(): Promise<void> {
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
  }

  const mine = async () =>
    (await new HttpClient({ server: serverUrl }).roster('dawn')).members.find(
      (m) => m.name === 'nick',
    )?.status_line ?? null;

  it('sets your own status line, and it lasts an hour', async () => {
    await setupTeam();
    const res = await capture(() =>
      statusLineCommand(parseArgs(['assembling a new dresser for the nursery'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('assembling a new dresser for the nursery');
    const line = await mine();
    expect(line?.text).toBe('assembling a new dresser for the nursery');
    expect(line!.expires_at - line!.set_at).toBe(3_600_000);
  });

  it('joins the words, so the status needs no quotes', async () => {
    await setupTeam();
    await capture(() => statusLineCommand(parseArgs(['at', 'the', 'vet'])));
    expect((await mine())?.text).toBe('at the vet');
  });

  it('--clear clears it, and the bare command says what yours is', async () => {
    await setupTeam();
    await capture(() => statusLineCommand(parseArgs(['back at 3'])));
    const shown = await capture(() => statusLineCommand(parseArgs([])));
    expect(shown.out).toContain('back at 3');
    await capture(() => statusLineCommand(parseArgs(['--clear'])));
    expect(await mine()).toBeNull();
    const none = await capture(() => statusLineCommand(parseArgs([])));
    expect(none.out).toMatch(/no status line/);
  });

  it('refuses 49 characters before it calls the daemon, naming the limit', async () => {
    await setupTeam();
    await expect(statusLineCommand(parseArgs(['x'.repeat(49)]))).rejects.toThrow(/48/);
  });
});
