import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsMusterdCredential } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { seatsCommand } from './seats.js';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-seats-')));
  const dir = join(home, 'musterd', 'acme', 'proj', 'ada');
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:9',
      team: 'acme',
      claim: { mode: 'seat', name: 'ada' },
      agent_key: 'mskey_SECRET',
    }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function capture(fn: () => Promise<number>) {
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

describe('musterd seats (ADR 491)', () => {
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  it('--json lists every seat, secret-free', async () => {
    const { code, out } = await capture(() =>
      seatsCommand(parseArgs(['--json']), { home, fetch: offline }),
    );
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.seats.map((s: { address: string }) => s.address)).toEqual(['acme/proj/ada']);
    expect(json.seats[0]).toMatchObject({ live: null, last_used: null });
    expect(containsMusterdCredential(out)).toBe(false);
  });

  it('prints the grouped list', async () => {
    const { out } = await capture(() => seatsCommand(parseArgs([]), { home, fetch: offline }));
    expect(out).toBe('seats on this machine · 1\n\nacme/proj\n  ada  claude   ○ idle\n');
  });
});
