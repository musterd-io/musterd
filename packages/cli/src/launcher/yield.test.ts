import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  leaseStillHeld,
  readYieldFile,
  stopWake,
  writeYieldFile,
  yieldDenyReason,
} from './yield.js';

const ws = () => {
  const d = mkdtempSync(join(tmpdir(), 'y-'));
  mkdirSync(join(d, '.musterd'));
  return d;
};

describe('yieldDenyReason (ADR 546)', () => {
  it('denies only the wake whose lease the marker names', () => {
    const d = ws();
    writeYieldFile(d, { lease_id: 'L1', by: 'nick', at: 1 });
    expect(yieldDenyReason(d, { MUSTERD_WAKE_LEASE: 'L1' })).toMatch(
      /^nick has taken over this seat — end your turn now; do not retry/,
    );
    expect(yieldDenyReason(d, { MUSTERD_WAKE_LEASE: 'L2' })).toBeNull(); // a later wake is untouched
    expect(yieldDenyReason(d, {})).toBeNull(); // a person's own session is never denied
  });

  it('no marker, or an unreadable one, denies nothing', () => {
    const d = ws();
    expect(yieldDenyReason(d, { MUSTERD_WAKE_LEASE: 'L1' })).toBeNull();
    writeFileSync(join(d, '.musterd', 'wake-yield.json'), '{not json');
    expect(yieldDenyReason(d, { MUSTERD_WAKE_LEASE: 'L1' })).toBeNull();
    expect(readYieldFile(d)).toBeNull();
  });
});

describe('writeYieldFile (ADR 546)', () => {
  it('replaces a symlink at the marker path instead of writing through it', () => {
    const d = ws();
    const target = join(d, 'victim');
    symlinkSync(target, join(d, '.musterd', 'wake-yield.json'));
    writeYieldFile(d, { lease_id: 'L1', by: 'nick', at: 1 });
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(join(d, '.musterd', 'wake-yield.json')).isSymbolicLink()).toBe(false);
    expect(readYieldFile(d)).toEqual({ lease_id: 'L1', by: 'nick', at: 1 });
  });
});

describe('stopWake (ADR 546)', () => {
  const fakeClock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  it('a wake that exits at its next tool call is yielded, and nothing is signalled', async () => {
    const d = ws();
    const c = fakeClock();
    let polls = 0;
    const kills: string[] = [];
    const r = await stopWake({ workspace: d, lease_id: 'L1', pid: 77 }, 'nick', {
      ...c,
      alive: () => ++polls < 3,
      kill: (p, s) => kills.push(`${p}:${s}`),
    });
    expect(r).toBe('yielded');
    expect(kills).toEqual([]);
    expect(readYieldFile(d)).toEqual({ lease_id: 'L1', by: 'nick', at: expect.any(Number) });
  });

  it('an in-process wake is never signalled: it is yielded once its lease clears', async () => {
    const d = ws();
    const c = fakeClock();
    let polls = 0;
    const kills: string[] = [];
    const r = await stopWake({ workspace: d, lease_id: 'L1', pid: 77, in_process: true }, 'nick', {
      ...c,
      holds: () => ++polls < 3,
      alive: () => true, // the host outlives the wake — its pid says nothing
      kill: (p, s) => kills.push(`${p}:${s}`),
    });
    expect(r).toBe('yielded');
    expect(kills).toEqual([]);
    expect(readYieldFile(d)).toMatchObject({ lease_id: 'L1', by: 'nick' });
  });

  it('an in-process wake that does not end within the grace is stuck, and still never signalled', async () => {
    const c = fakeClock();
    const kills: string[] = [];
    const r = await stopWake(
      { workspace: ws(), lease_id: 'L1', pid: 77, in_process: true },
      'nick',
      {
        ...c,
        holds: () => true,
        alive: () => true,
        kill: (p, s) => kills.push(`${p}:${s}`),
      },
    );
    expect(r).toBe('stuck');
    expect(kills).toEqual([]);
  });

  it('a wake still alive after the grace gets SIGTERM to its group, then SIGKILL', async () => {
    const d = ws();
    const c = fakeClock();
    const kills: string[] = [];
    const r = await stopWake({ workspace: d, lease_id: 'L1', pid: 77 }, 'nick', {
      ...c,
      alive: () => true,
      holds: () => true,
      kill: (p, s) => kills.push(`${p}:${s}`),
    });
    expect(r).toBe('killed');
    expect(kills).toEqual(['-77:SIGTERM', '-77:SIGKILL']);
  });

  it('a wake that dies on SIGTERM is not sent SIGKILL', async () => {
    const d = ws();
    const c = fakeClock();
    const kills: string[] = [];
    const r = await stopWake({ workspace: d, lease_id: 'L1', pid: 77 }, 'nick', {
      ...c,
      alive: () => kills.length === 0,
      holds: () => true,
      kill: (p, s) => kills.push(`${p}:${s}`),
    });
    expect(r).toBe('killed');
    expect(kills).toEqual(['-77:SIGTERM']);
  });

  it('signals nothing once the lease no longer names the pid — it may be a stranger now', async () => {
    const d = ws();
    const c = fakeClock();
    const kills: string[] = [];
    const r = await stopWake({ workspace: d, lease_id: 'L1', pid: 77 }, 'nick', {
      ...c,
      alive: () => true,
      holds: () => false,
      kill: (p, s) => kills.push(`${p}:${s}`),
    });
    expect(r).toBe('yielded');
    expect(kills).toEqual([]);
  });
});

describe('leaseStillHeld (ADR 546)', () => {
  const lease = (over: object = {}) => ({
    lease_id: 'L1',
    provenance: 'wake',
    harness: 'claude-code',
    spawner_pid: 77,
    started_at: 1,
    expires_at: 2,
    ...over,
  });
  it('holds only for the same lease and the same pid', () => {
    const d = ws();
    writeFileSync(join(d, '.musterd', 'wake-lease.json'), JSON.stringify(lease()));
    expect(leaseStillHeld(d, 'L1', 77)).toBe(true);
    expect(leaseStillHeld(d, 'L2', 77)).toBe(false);
    expect(leaseStillHeld(d, 'L1', 78)).toBe(false);
    expect(leaseStillHeld(ws(), 'L1', 77)).toBe(false); // no file: the host cleared it
  });
});
