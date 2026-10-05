import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hold } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { holdCommand, enforcementNote, renderHolds } from './hold.js';
import { teamCommand } from './team.js';

/**
 * ADR 516 — `musterd hold set|lift|list` as the human who created the team (its admin). The daemon
 * decides who may set a hold; this pins the CLI's words: what a hold says it does, and that every
 * line names the effect, the human and the end.
 */
describe('hold command (ADR 516)', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-hold-'));
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

  it('set → list → lift, each line naming the effect, the human and the end', async () => {
    const set = await capture(() =>
      holdCommand(
        parseArgs(['set', 'autorefresh_paused', '--for', '90m', '--reason', 'demo 14:00']),
      ),
    );
    expect(set.code).toBe(0);
    expect(set.out).toMatch(
      /autorefresh paused by nick until \d\d:\d\d \(1h30m left\): demo 14:00/,
    );
    expect(set.out).toContain('every machine’s autorefresh stands down');

    const list = await capture(() => holdCommand(parseArgs(['list', '--json'])));
    const holds = JSON.parse(list.out) as Hold[];
    expect(holds).toHaveLength(1);

    const lifted = await capture(() => holdCommand(parseArgs(['lift', holds[0]!.id])));
    expect(lifted.out).toContain('lifted: autorefresh paused — demo 14:00');
    expect((await capture(() => holdCommand(parseArgs(['list'])))).out).toContain(
      'no holds in force',
    );
  });

  it('a lift of nothing names the next step', async () => {
    await expect(capture(() => holdCommand(parseArgs(['lift', 'nope'])))).rejects.toThrow(
      /musterd hold list/,
    );
  });

  it('refuses an effect outside the list, a missing reason and an over-cap length', async () => {
    await expect(
      capture(() =>
        holdCommand(parseArgs(['set', 'nobody_merges', '--for', '1h', '--reason', 'x'])),
      ),
    ).rejects.toThrow(/usage/);
    await expect(
      capture(() => holdCommand(parseArgs(['set', 'notice', '--for', '1h']))),
    ).rejects.toThrow(/usage/);
    await expect(
      capture(() => holdCommand(parseArgs(['set', 'notice', '--for', '20h', '--reason', 'x']))),
    ).rejects.toThrow(/12h/);
  });
});

describe('hold rendering', () => {
  const now = new Date(2026, 9, 5, 14, 0).getTime();
  const base: Hold = {
    id: 'h1',
    effect: 'notice',
    reason: 'leave the deck',
    created_by: 'nick',
    created_at: now,
    expires_at: now + 3600_000,
    lifted_at: null,
    lifted_by: null,
  };

  it('a notice says it is not enforced; an ended hold says how it ended', () => {
    const out = renderHolds(
      [
        base,
        { ...base, id: 'h2', lifted_at: now, lifted_by: 'nick' },
        { ...base, id: 'h3', expires_at: now - 1 },
      ],
      now,
    );
    expect(out).toContain('notice — not enforced by nick');
    expect(out).toContain('lifted by nick');
    expect(out).toContain('ended');
    expect(enforcementNote('notice')).toContain('enforced nowhere');
    expect(enforcementNote('merges_paused')).toContain('increment 2');
  });
});
