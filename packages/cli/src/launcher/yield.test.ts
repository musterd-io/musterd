import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readYieldFile, stopWake, writeYieldFile, yieldDenyReason } from './yield.js';

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

  it('a wake still alive after the grace gets SIGTERM to its group, then SIGKILL', async () => {
    const d = ws();
    const c = fakeClock();
    const kills: string[] = [];
    const r = await stopWake({ workspace: d, lease_id: 'L1', pid: 77 }, 'nick', {
      ...c,
      alive: () => true,
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
      kill: (p, s) => kills.push(`${p}:${s}`),
    });
    expect(r).toBe('killed');
    expect(kills).toEqual(['-77:SIGTERM']);
  });
});
