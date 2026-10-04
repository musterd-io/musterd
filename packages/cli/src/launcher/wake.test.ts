import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { MemberEntry, Seat } from './store.js';
import { viewerSeatFor, wakeMember } from './wake.js';

const seat = (
  member: string,
  kind: 'agent' | 'human' = 'agent',
  over: Partial<Seat> = {},
): Seat => ({
  address: `revive/agents/${member}`,
  team: 'revive',
  project: 'agents',
  member,
  server: 'http://127.0.0.1:4849',
  path: `/w/${member}`,
  kind,
  harnesses: [],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});
const bo: MemberEntry = {
  team: 'revive',
  member: 'bo',
  kind: 'agent',
  address: null,
  where: 'node',
  node: 'n-air',
  where_label: 'air-2',
  can: 'wake',
};

function fakeSpawn(code: number) {
  const calls: { bin: string; args: string[]; cwd: string | undefined }[] = [];
  const spawn = vi.fn((bin: string, args: string[], opts: { cwd?: string }) => {
    calls.push({ bin, args, cwd: opts.cwd });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', code));
    return child;
  });
  return { spawn: spawn as never, calls };
}

describe('the doorbell from the front door (ADR 503 Decision 2)', () => {
  it('rings as the viewer, from their own Workspace here: `musterd send --act steer` with the launcher marker', async () => {
    const { spawn, calls } = fakeSpawn(0);
    const err: string[] = [];
    const seats = [seat('ada'), seat('nick', 'human')];
    const code = await wakeMember(bo, seats, 'nick', {
      spawn,
      bin: { exec: '/usr/bin/node', entry: '/m/bin.js' },
      err: (s) => err.push(s),
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe('/w/nick');
    expect(calls[0]!.args.slice(0, 8)).toEqual([
      '/m/bin.js',
      'send',
      '--to',
      'bo',
      '--act',
      'steer',
      '--meta',
      'launch_surface=picker',
    ]);
    expect(err.join('')).toContain('ringing bo (on air-2) as nick');
  });

  it('returns the send exit code', async () => {
    const { spawn } = fakeSpawn(3);
    expect(
      await wakeMember(bo, [seat('nick', 'human')], 'nick', {
        spawn,
        bin: { exec: 'n', entry: 'e' },
        err: () => {},
      }),
    ).toBe(3);
  });

  it('refuses without a human Workspace here to ring from — never a vault (ADR 442)', async () => {
    await expect(wakeMember(bo, [seat('ada')], 'nick', { err: () => {} })).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('musterd human <you>'),
    });
  });

  it('viewerSeatFor: the named human seat, else the only one, else none', () => {
    const nick = seat('nick', 'human');
    const sam = seat('sam', 'human');
    expect(viewerSeatFor('revive', [seat('ada'), nick], 'nick')).toBe(nick);
    expect(viewerSeatFor('revive', [seat('ada'), nick], null)).toBe(nick);
    expect(viewerSeatFor('revive', [nick, sam], null)).toBeNull();
    expect(
      viewerSeatFor(
        'revive',
        [seat('nick', 'human', { problem: { kind: 'binding-invalid', fix: 'x' } })],
        'nick',
      ),
    ).toBeNull();
  });
});
