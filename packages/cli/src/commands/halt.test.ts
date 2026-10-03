import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig } from '../config.js';
import { haltCommand, resumeCommand, ungatedSurfaceNotice } from './halt.js';
import { teamCommand } from './team.js';

/**
 * ADR 501 increment 2 — `musterd halt <seat> --reason` / `musterd resume <seat>` as a human. The
 * server decides who may halt; this pins the CLI's words: what a halt says, what a resume says,
 * and that every refusal names the next runnable step (ADR 055).
 */
describe('halt / resume commands (ADR 501)', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;
  let nick: HttpClient;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-halt-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
    nick = new HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
      seat: 'nick',
    });
    await nick.addMember('dawn', { name: 'Ada', kind: 'agent' });
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

  it('halts a seat with a reason and states the honest limit', async () => {
    const res = await capture(() => haltCommand(parseArgs(['Ada', '--reason', 'wrong lane'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('halted Ada');
    expect(res.out).toContain('wrong lane');
    expect(res.out).toContain('next tool boundary');
    expect(res.out).toContain('musterd resume Ada');
    const roster = await nick.roster('dawn');
    const ada = roster.members.find((m) => m.name === 'Ada')!;
    expect(ada.halted).toMatchObject({ by: 'nick', reason: 'wrong lane' });
  });

  it('refuses to halt without a reason, naming the flag', async () => {
    await expect(haltCommand(parseArgs(['Ada']))).rejects.toThrow(/--reason/);
  });

  it('resumes a halted seat and says who had halted it', async () => {
    await capture(() => haltCommand(parseArgs(['Ada', '--reason', 'wrong lane'])));
    const res = await capture(() => resumeCommand(parseArgs(['Ada'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('resumed Ada');
    expect(res.out).toContain('halted by nick');
    const roster = await nick.roster('dawn');
    expect(roster.members.find((m) => m.name === 'Ada')!.halted).toBeNull();
  });

  it('a second halt is refused and names resume as the next step', async () => {
    await capture(() => haltCommand(parseArgs(['Ada', '--reason', 'first'])));
    await expect(haltCommand(parseArgs(['Ada', '--reason', 'second']))).rejects.toThrow(
      /musterd resume Ada/,
    );
  });

  it('an unknown seat is refused with the roster as the next step', async () => {
    await expect(haltCommand(parseArgs(['Nobody', '--reason', 'x']))).rejects.toThrow(
      /musterd status/,
    );
  });

  it('--json prints the server reply', async () => {
    const res = await capture(() =>
      haltCommand(parseArgs(['Ada', '--reason', 'wrong lane', '--json'])),
    );
    const json = JSON.parse(res.out) as { member: string; halted: { by: string } };
    expect(json.member).toBe('Ada');
    expect(json.halted.by).toBe('nick');
  });
});

/**
 * Lane 01M41Q39C9: the honest limit, per surface. A harness with no PreToolUse hook (Codex, ADR
 * 442) cannot deny the seat's next local tool call, so the halt frame says so — once, naming the
 * surface — and stays silent on gated harnesses and when nothing was evicted.
 */
describe('ungatedSurfaceNotice', () => {
  it('names an ungated surface and what still stops the seat', () => {
    expect(ungatedSurfaceNotice(['codex'])).toBe(
      'local tools are not gated on codex — the seat stops at its next musterd call',
    );
  });

  it('is silent for gated harnesses and for no evictions', () => {
    expect(ungatedSurfaceNotice(['claude-code', 'cursor', 'grok', 'cli'])).toBeNull();
    expect(ungatedSurfaceNotice([])).toBeNull();
    expect(ungatedSurfaceNotice(undefined)).toBeNull();
  });

  it('lists several ungated surfaces once each', () => {
    expect(ungatedSurfaceNotice(['codex', 'opencode', 'codex'])).toMatch(/on codex, opencode —/);
  });
});
