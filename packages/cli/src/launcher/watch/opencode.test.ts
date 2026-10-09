import { describe, expect, it } from 'vitest';
import { opencodeReader, watchRows, type Row } from './opencode.js';

const msg = (over: object = {}) =>
  JSON.stringify({
    role: 'assistant',
    finish: 'tool-calls',
    time: { completed: 1787676666000 },
    ...over,
  });
const row = (mid: string, mt: number, md: string, part: object | null): Row => ({
  mid,
  mt,
  md,
  pd: part ? JSON.stringify(part) : null,
});

// Shapes copied from a real opencode.db (2026-10-08); contents invented.
const rows: Row[] = [
  row('m1', 10, msg(), { type: 'step-start' }),
  row('m1', 10, msg(), { type: 'reasoning', text: 'SECRET REASONING' }),
  row('m1', 10, msg(), {
    type: 'text',
    text: "I'll check\nthe env.",
    time: { start: 1787676665000 },
  }),
  row('m1', 10, msg(), {
    type: 'tool',
    tool: 'bash',
    callID: 'bash_1',
    state: {
      status: 'completed',
      input: { command: 'env | grep -i musterd' },
      output: 'TOOL OUTPUT SECRET',
      metadata: { output: 'METADATA SECRET', exit: 0 },
    },
  }),
  row('m1', 10, msg(), { type: 'step-finish', tokens: { input: 1 } }),
  row('m2', 20, msg({ finish: 'stop' }), { type: 'text', text: 'Done.' }),
];

describe('opencode watchRows (ADR 546)', () => {
  it('shows its words and its tool calls, in order, and the last finish reason', () => {
    const { events, finish } = watchRows(rows);
    expect(events.map((e) => e.line)).toEqual([
      "“I'll check the env.”",
      '▸ bash  env | grep -i musterd',
      '“Done.”',
    ]);
    expect(finish).toBe('stop');
    expect(events[0]!.ts).toBe(1787676665000);
  });

  it('never shows tool output, metadata, reasoning or step bookkeeping', () => {
    const text = watchRows(rows)
      .events.map((e) => e.line)
      .join('\n');
    for (const secret of ['TOOL OUTPUT SECRET', 'METADATA SECRET', 'SECRET REASONING', 'tokens'])
      expect(text).not.toContain(secret);
  });

  it('scrubs a credential and strips escapes', () => {
    const key = 'mskey_abcdefabcdefabcdefabcdef0123456789';
    const evil = [
      row('m', 1, msg(), { type: 'text', text: `key ${key}\u001b[2J` }),
      row('m', 1, msg(), {
        type: 'tool',
        tool: 'bash',
        state: { input: { command: `echo ${key}\u001b]0;x\u0007` } },
      }),
    ];
    for (const e of watchRows(evil).events) {
      expect(e.line).not.toContain('mskey_abcdef');
      // eslint-disable-next-line no-control-regex
      expect(e.line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });

  it('skips a message whose JSON does not parse', () => {
    expect(watchRows([row('m', 1, '{bad', { type: 'text', text: 'x' })]).events).toEqual([]);
  });
});

describe('opencodeReader (ADR 546)', () => {
  const wake = {
    lease_id: 'L',
    pid: 1,
    session_id: 'ses_1',
    harness: 'opencode',
    started_at: 1,
    workspace: '/w',
  };

  it('asks only for messages newer than the last it saw, and accumulates', async () => {
    const asked: string[] = [];
    const answers = [JSON.stringify(rows.slice(0, 5)), JSON.stringify(rows.slice(5)), '[]'];
    const r = opencodeReader({
      dbPath: '/db',
      run: async (_db, sql) => (asked.push(sql), answers.shift()!),
    });
    const first = await r.snapshot(wake);
    expect(first).toEqual({ events: expect.any(Array), endedCleanly: false });
    expect(first!.events).toHaveLength(2);
    const second = await r.snapshot(wake);
    expect(second!.events).toHaveLength(3);
    expect(second!.endedCleanly).toBe(true);
    await r.snapshot(wake);
    expect(asked[0]).toContain('time_created > 0');
    expect(asked[1]).toContain('time_created > 10');
    expect(asked[2]).toContain('time_created > 20');
  });

  it('is null when sqlite cannot read it, and keeps the last good answer afterwards', async () => {
    const answers: Array<string | null> = [null, JSON.stringify(rows), null];
    const r = opencodeReader({ run: async () => answers.shift()! });
    expect(await r.snapshot(wake)).toBeNull();
    const good = await r.snapshot(wake);
    expect(good!.events).toHaveLength(3);
    expect((await r.snapshot(wake))!.events).toHaveLength(3);
  });

  it('refuses a session id outside opencode’s alphabet — it goes into SQL', async () => {
    let ran = false;
    const r = opencodeReader({ run: async () => ((ran = true), '[]') });
    expect(await r.snapshot({ ...wake, session_id: "x'; DROP TABLE message;--" })).toBeNull();
    expect(await r.snapshot({ ...wake, session_id: null })).toBeNull();
    expect(ran).toBe(false);
  });
});
