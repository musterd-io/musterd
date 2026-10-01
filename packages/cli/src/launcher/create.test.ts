import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actingSeat, createSeat } from './create.js';
import type { Seat } from './store.js';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-create-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function write(member: string, b: Record<string, unknown>): string {
  const dir = join(home, 'musterd', 'acme', 'proj', member);
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:4849',
      team: 'acme',
      claim: { mode: 'seat', name: member },
      ...b,
    }),
  );
  return dir;
}
const seat = (member: string, kind: 'agent' | 'human', path: string): Seat => ({
  address: `acme/proj/${member}`,
  team: 'acme',
  project: 'proj',
  member,
  server: 'http://127.0.0.1:4849',
  path,
  kind,
  harnesses: [],
  remote: null,
  last_session: null,
  problem: null,
});

describe('createSeat (ADR 491 §4.7)', () => {
  it('acts from your human Workspace in the same team and project', () => {
    const nick = seat('nick', 'human', '/w/nick');
    expect(actingSeat('acme', 'proj', [seat('ada', 'agent', '/w/ada'), nick])).toBe(nick);
    expect(actingSeat('acme', 'other', [nick])).toBeNull();
  });

  it('without a human Workspace here, says how to make one', async () => {
    await expect(
      createSeat({
        team: 'acme',
        project: 'proj',
        member: 'slate',
        harnesses: ['codex'],
        seats: [],
        home,
      }),
    ).rejects.toThrow(/set up your own seat in acme\/proj first: musterd human <you>/);
  });

  it('provisions with your credential and the remote base, then returns the new seat from the catalog', async () => {
    const nickDir = write('nick', { agent_key: 'mscr_nick' });
    const client = vi.fn(() => ({}) as never);
    const provision = vi.fn(async () => {
      const dir = write('slate', { agent_key: 'msac_new' });
      return {
        workspace: { dir, kind: 'worktree' as const, created: true },
        reused: false,
        granted: true,
        wiring: null,
        wiringError: null,
      };
    });
    const created = await createSeat(
      {
        team: 'acme',
        project: 'proj',
        member: 'slate',
        harnesses: ['codex'],
        seats: [seat('nick', 'human', nickDir)],
        home,
      },
      { client, provision, baseRef: () => 'abc123' },
    );
    expect(client).toHaveBeenCalledWith('http://127.0.0.1:4849', 'mscr_nick');
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'slate',
        team: 'acme',
        harnesses: ['codex'],
        sourceDir: nickDir,
        base: 'abc123',
      }),
    );
    expect(created.address).toBe('acme/proj/slate');
  });

  it('incomplete wiring is an error that names the fix', async () => {
    const nickDir = write('nick', { agent_key: 'mscr_nick' });
    const provision = vi.fn(async () => ({
      workspace: { dir: write('slate', {}), kind: 'worktree' as const, created: true },
      reused: false,
      granted: true,
      wiring: null,
      wiringError: 'codex: failed',
    }));
    await expect(
      createSeat(
        {
          team: 'acme',
          project: 'proj',
          member: 'slate',
          harnesses: ['codex'],
          seats: [seat('nick', 'human', nickDir)],
          home,
        },
        { client: () => ({}) as never, provision, baseRef: () => null },
      ),
    ).rejects.toThrow(/wiring is incomplete: codex: failed — run `musterd wire` there/);
  });
});
