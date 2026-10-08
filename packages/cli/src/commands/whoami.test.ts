import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { saveBinding } from '../config.js';
import { teamCommand } from './team.js';
import { whoamiCommand } from './whoami.js';

/**
 * `musterd whoami` used to answer "alfie on revive (cli · binding)" for a seat whose credential the
 * team had revoked: a seat that could do nothing looked healthy (alfie, 2026-10-07, lane 01M4E4MP4M).
 * It now asks the daemon once, best-effort, and says so when the credential is rejected.
 */
describe('whoami and a credential the team no longer honours', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-whoami-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
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

  /** A seat folder holding only a bootstrap key — what a re-provisioned seat starts with. */
  async function seatFolder(revoke: boolean): Promise<string> {
    await capture(() => teamCommand(parseArgs(['add', 'Ada', '--kind', 'agent'])));
    const minted = JSON.parse(
      (
        await capture(() =>
          teamCommand(parseArgs(['bootstrap', 'mint', '--seat', 'Ada', '--json'])),
        )
      ).out,
    );
    if (revoke) {
      await capture(() =>
        teamCommand(parseArgs(['bootstrap', 'revoke', minted.credential.id, '--json'])),
      );
    }
    const ws = mkdtempSync(join(dir, 'ws-ada-'));
    saveBinding(ws, {
      version: 2,
      server: serverUrl,
      team: 'dawn',
      agent_key: minted.agent_key,
      claim: { mode: 'seat', name: 'Ada' },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(ws);
    return ws;
  }

  it('still names the seat, and then says the credential is rejected and what to run', async () => {
    await seatFolder(true);
    const res = await capture(() => whoamiCommand(parseArgs(['whoami'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('Ada');
    expect(res.out).toContain('credential rejected');
    expect(res.out).toContain('revoked');
    expect(res.out).toContain('musterd team bootstrap mint --seat Ada --install');
  });

  it('carries the verdict in --json', async () => {
    await seatFolder(true);
    const body = JSON.parse(
      (await capture(() => whoamiCommand(parseArgs(['whoami', '--json'])))).out,
    );
    expect(body.member).toBe('Ada');
    expect(body.credential).toMatchObject({ ok: false });
    expect(body.credential.problem).toContain('revoked');
  });

  it('says nothing extra for a credential the team honours', async () => {
    await seatFolder(false);
    const res = await capture(() => whoamiCommand(parseArgs(['whoami'])));
    expect(res.out).toContain('Ada');
    expect(res.out).not.toContain('rejected');
  });

  it('stays silent when the daemon cannot be reached — an offline machine is not a bad credential', async () => {
    await seatFolder(true);
    process.env['MUSTERD_SERVER'] = 'http://127.0.0.1:1';
    const res = await capture(() => whoamiCommand(parseArgs(['whoami'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('Ada');
    expect(res.out).not.toContain('rejected');
  });

  it('does not call a seat that has not claimed yet rejected — it holds a live key and is told to claim', async () => {
    await seatFolder(false);
    const res = await capture(() => whoamiCommand(parseArgs(['whoami'])));
    expect(res.out).not.toContain('rejected');
  });
});
