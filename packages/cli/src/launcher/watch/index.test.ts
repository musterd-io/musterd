import { describe, expect, it } from 'vitest';
import type { LocalWake } from '../live.js';
import type { Seat } from '../store.js';
import { readCompleteLines, watchWake, type Keys } from './index.js';

const rec = (o: object) => JSON.stringify(o);
const say = (text: string, stop = 'tool_use') =>
  rec({ type: 'assistant', message: { stop_reason: stop, content: [{ type: 'text', text }] } });
const wake: LocalWake = {
  lease_id: 'L1',
  pid: 77,
  session_id: 'S-1',
  harness: 'claude-code',
  started_at: 1,
  workspace: '/w/stanley',
};
const seat = { member: 'stanley' } as Seat;

/** A scripted keyboard: `press` is read on the Nth call to `next()`; null once exhausted. */
function keyboard(script: Array<'enter' | 'esc' | null | 'never'>): Keys & { closed: boolean } {
  const k = {
    closed: false,
    next: (): Promise<'enter' | 'esc' | null> => {
      const v = script.shift();
      if (v === 'never' || v === undefined) return new Promise(() => {});
      return Promise.resolve(v);
    },
    close: () => {
      k.closed = true;
    },
  };
  return k;
}

function run(
  over: NonNullable<Parameters<typeof watchWake>[2]> & { frames?: string[][]; alive?: boolean[] },
) {
  const out: string[] = [];
  const { frames: scripted, alive: aliveScript, ...rest } = over;
  const frames = scripted ?? [[]];
  let read = 0;
  const alives = aliveScript ?? [true];
  let polls = 0;
  const result = watchWake(wake, seat, {
    transcriptPath: () => '/t/S-1.jsonl',
    readLines: () => frames[Math.min(read++, frames.length - 1)]!,
    alive: () => alives[Math.min(polls++, alives.length - 1)]!,
    // A real macrotask per tick, so a key pressed later by the test can land.
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    cols: 80,
    out: (s) => out.push(s),
    ...rest,
  });
  return { result, out };
}

describe('watchWake (ADR 546)', () => {
  it('prints the header and the last 10 events of the backlog', async () => {
    const backlog = Array.from({ length: 12 }, (_, i) => say(`step ${i}`));
    const { result, out } = run({ frames: [backlog], keys: keyboard(['esc']) });
    expect(await result).toBe('leave');
    expect(out[0]).toMatch(/^watching stanley's wake — ⏎ take over · esc leave/);
    expect(out.slice(1)).toHaveLength(10);
    expect(out[1]).toContain('step 2');
    expect(out.at(-1)).toContain('step 11');
  });

  it('prints new lines once, never twice', async () => {
    const a = [say('one')];
    const b = [...a, say('two', 'end_turn')];
    const { result, out } = run({
      frames: [a, a, b, b],
      alive: [true, true, true, false],
      keys: keyboard(['never']),
    });
    await result;
    const text = out.join('');
    expect(text.match(/one/g)).toHaveLength(1);
    expect(text.match(/two/g)).toHaveLength(1);
  });

  it('⏎ takes over and esc leaves', async () => {
    expect(await run({ keys: keyboard(['enter']) }).result).toBe('take-over');
    expect(await run({ keys: keyboard(['esc']) }).result).toBe('leave');
  });

  it('a wake that ends on end_turn says it finished and opens its conversation', async () => {
    const { result, out } = run({
      frames: [[say('done', 'end_turn')]],
      alive: [false],
      keys: keyboard(['never']),
    });
    expect(await result).toBe('finished');
    expect(out.join('')).toContain('wake finished — opening its conversation');
  });

  it('a wake that ended early asks first: ⏎ opens it, esc quits', async () => {
    const early = { frames: [[say('mid-task')]], alive: [false] };
    for (const [press, want] of [
      ['enter', 'ended'],
      ['esc', 'leave'],
    ] as const) {
      let deliver: (k: 'enter' | 'esc') => void = () => {};
      const keys: Keys = {
        next: () => new Promise((r) => (deliver = r)),
        close: () => {},
      };
      const { result, out } = run({ ...early, keys });
      await new Promise((r) => setTimeout(r, 30)); // the wake is gone; the prompt is up
      expect(out.join('')).toContain('wake ended before finishing');
      deliver(press);
      expect(await result).toBe(want);
    }
  });

  it("can't watch a wake with no transcript, or a non-Claude one", async () => {
    const none = run({ transcriptPath: () => undefined, keys: keyboard(['never']) });
    expect(await none.result).toBe('leave');
    expect(none.out.join('')).toContain("can't watch: no transcript for this wake yet");
    const out: string[] = [];
    expect(
      await watchWake({ ...wake, harness: 'codex' }, seat, {
        out: (s) => out.push(s),
        keys: keyboard(['never']),
      }),
    ).toBe('leave');
  });

  it('releases the keyboard it opened itself', async () => {
    // Injected keys belong to the caller; only a keyboard watch opened is closed by watch.
    const k = keyboard(['esc']);
    await run({ keys: k }).result;
    expect(k.closed).toBe(false);
  });
});

describe('readCompleteLines', () => {
  it('drops a half-written last line', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(mkdtempSync(join(tmpdir(), 'rcl-')), 't.jsonl');
    writeFileSync(f, 'a\nb\nhalf');
    expect(readCompleteLines(f)).toEqual(['a', 'b']);
    writeFileSync(f, 'a\nb\n');
    expect(readCompleteLines(f)).toEqual(['a', 'b']);
  });
});
