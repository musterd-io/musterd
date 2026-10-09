import { describe, expect, it } from 'vitest';
import type { LocalWake } from '../live.js';
import { nativeReader, watchEvents } from './native.js';

const wake: LocalWake = {
  lease_id: 'L1',
  pid: 100,
  session_id: null,
  harness: 'musterd',
  started_at: 0,
  workspace: '/w',
  in_process: true,
};
const j = (o: object): string => JSON.stringify(o);

const spool = [
  j({ lease_id: 'L1' }),
  j({ t: 1_000, k: 'text', s: 'checking\nthe inbox' }),
  j({ t: 2_000, k: 'tool', n: 'team_inbox_check', a: '' }),
  j({ t: 3_000, k: 'tool', n: 'team_send', a: 'nick' }),
];

describe('watchEvents — the native spool', () => {
  it('shows words and tool calls, one line each, and no result field can reach the screen', () => {
    const s = watchEvents(
      [...spool, j({ t: 4, k: 'tool', n: 'x', a: 'y', result: 'SECRET' })],
      'L1',
    )!;
    expect(s.events.map((e) => e.line)).toEqual([
      '“checking the inbox”',
      '▸ team_inbox_check',
      '▸ team_send  nick',
      '▸ x  y',
    ]);
    expect(JSON.stringify(s)).not.toContain('SECRET');
  });

  it('ended cleanly only on an `end: clean` line', () => {
    expect(watchEvents(spool, 'L1')!.endedCleanly).toBe(false);
    expect(watchEvents([...spool, j({ end: 'early' })], 'L1')!.endedCleanly).toBe(false);
    expect(watchEvents([...spool, j({ end: 'clean' })], 'L1')!.endedCleanly).toBe(true);
  });

  it('reads as nothing when the spool belongs to another lease, or has no header', () => {
    expect(watchEvents(spool, 'L2')).toBeNull();
    expect(watchEvents(spool.slice(1), 'L1')).toBeNull();
    expect(watchEvents([], 'L1')).toBeNull();
  });

  it('skips noise and half-written lines, and scrubs credentials and control characters', () => {
    const s = watchEvents(
      [
        spool[0]!,
        'not json',
        j({ t: 1, k: 'text', s: `\u001b]0;pwned\u0007 key mskey_${'a'.repeat(40)}` }),
        j({ t: 2, k: 'nonsense' }),
      ],
      'L1',
    )!;
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.line).not.toContain('\u001b');
    expect(s.events[0]!.line).not.toContain('mskey_aaaa');
  });
});

describe('nativeReader', () => {
  it('is null until the spool exists, then re-reads it on every poll', () => {
    let lines: string[] | null = null;
    const r = nativeReader({
      readLines: () => {
        if (!lines) throw new Error('ENOENT');
        return lines;
      },
    });
    expect(r.snapshot(wake)).toBeNull();
    lines = spool.slice(0, 2);
    expect((r.snapshot(wake) as { events: unknown[] }).events).toHaveLength(1);
    lines = spool;
    expect((r.snapshot(wake) as { events: unknown[] }).events).toHaveLength(3);
  });
});
