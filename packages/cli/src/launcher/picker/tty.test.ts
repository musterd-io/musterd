import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_LAUNCHER_FILE, type Seat } from '../store.js';
import { initialState, reduce } from './state.js';
import { runPicker } from './tty.js';

const seat = (member: string): Seat => ({
  address: `revive/agents/${member}`,
  team: 'revive',
  project: 'agents',
  member,
  server: '',
  path: `/w/${member}`,
  kind: 'agent',
  harnesses: [],
  remote: null,
  last_session: null,
  problem: null,
});
function io() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let written = '';
  output.on('data', (c: Buffer) => (written += c.toString()));
  return { input, output, written: () => written };
}
const STATE = initialState(
  {
    ...EMPTY_LAUNCHER_FILE,
    snapshot: { taken_at: 0, seats: [seat('stanley'), seat('miley')], teams: [] },
  },
  '',
  0,
);

describe('runPicker (ADR 491)', () => {
  it('typing then ⏎ resolves the outcome and restores the terminal', async () => {
    const t = io();
    const done = runPicker(STATE, t as never, () => {});
    t.input.write('sta');
    t.input.write('\r');
    expect(await done).toMatchObject({
      kind: 'launch',
      seat: { member: 'stanley' },
      mode: 'fresh',
    });
    expect(t.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(t.written()).toContain('\u001b[?1049h');
    expect(t.written().endsWith('\u001b[?25h\u001b[?1049l')).toBe(true);
  });

  it('async events repaint; ⌃C quits 130', async () => {
    const t = io();
    const done = runPicker(STATE, t as never, (dispatch) => {
      dispatch({ type: 'live', live: {}, status: 'offline', now: 0 });
    });
    t.input.write('\u0003');
    expect(await done).toEqual({ kind: 'quit', code: 130 });
    expect(t.written()).toContain('offline · live state unavailable');
  });

  it('restores the terminal when the reducer throws, and rejects', async () => {
    const t = io();
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    const done = runPicker(STATE, t as never, () => {}, boom as unknown as typeof reduce);
    t.input.write('x');
    await expect(done).rejects.toThrow('boom');
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.written().endsWith('\u001b[?25h\u001b[?1049l')).toBe(true);
  });
});
