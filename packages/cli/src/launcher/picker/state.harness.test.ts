import { describe, expect, it } from 'vitest';
import { EMPTY_LAUNCHER_FILE, type LauncherFile, type Seat } from '../store.js';
import { initialState, reduce, type Key, type PickerState } from './state.js';

/**
 * The harness step (lane 01M3WTTQ6V, nick 2026-10-01): picking an agent seat always shows the
 * harnesses it is configured for — even just one — and launches only on an explicit pick.
 */
const seat = (member: string, over: Partial<Seat> = {}): Seat => ({
  address: `revive/agents/${member}`,
  team: 'revive',
  project: 'agents',
  member,
  server: 'http://127.0.0.1:4849',
  path: `/w/${member}`,
  kind: 'agent',
  harnesses: ['claude-code'],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});
const file = (seats: Seat[], lastHarness: string | null = null): LauncherFile => ({
  ...EMPTY_LAUNCHER_FILE,
  last: seats[0]!.address,
  seats: Object.fromEntries(
    seats.map((x, i) => [
      x.address,
      {
        path: x.path,
        harness: lastHarness ?? 'claude-code',
        mode: 'fresh' as const,
        launched_at: 900 - i,
        ended_at: null,
        exit: null,
      },
    ]),
  ),
  snapshot: { taken_at: 1_000, seats, teams: [{ team: 'revive', here: true }] },
});
const key = (name: string, extra: Partial<Key> = {}) => ({
  type: 'key' as const,
  key: { name, ...extra },
});
const press = (s: PickerState, ...keys: ReturnType<typeof key>[]) => {
  let out = { state: s, outcome: null as ReturnType<typeof reduce>['outcome'] };
  for (const k of keys) out = reduce(out.state, k);
  return out;
};
const ok = (s: PickerState) =>
  reduce(s, { type: 'live', live: {}, status: 'ok', now: 1_000 }).state;

describe('the harness step', () => {
  it('a one-harness seat still shows its one harness and waits for the pick', () => {
    const s = ok(initialState(file([seat('stanley')]), '', 1_000));
    const first = press(s, key('return'));
    expect(first.outcome).toBeNull();
    expect(first.state.choose).toMatchObject({ options: ['claude-code'], index: 0, mode: 'fresh' });
    expect(press(first.state, key('return')).outcome).toMatchObject({
      kind: 'launch',
      harness: 'claude-code',
      mode: 'fresh',
    });
  });

  it('lists the configured set, preselects the one used last, and ↑↓ choose', () => {
    const s = ok(
      initialState(
        file([seat('ada', { harnesses: ['claude-code', 'codex'] })], 'codex'),
        '',
        1_000,
      ),
    );
    const open = press(s, key('return')).state;
    expect(open.choose).toMatchObject({ options: ['claude-code', 'codex'], index: 1 });
    expect(press(open, key('up'), key('return')).outcome).toMatchObject({ harness: 'claude-code' });
  });

  it('esc goes back to the list and launches nothing', () => {
    const s = ok(initialState(file([seat('stanley')]), '', 1_000));
    const back = press(s, key('return'), key('escape'));
    expect(back.outcome).toBeNull();
    expect(back.state.choose).toBeNull();
  });

  it('⌃R opens the same step and resumes', () => {
    const s = ok(initialState(file([seat('stanley')]), '', 1_000));
    expect(press(s, key('r', { ctrl: true }), key('return')).outcome).toMatchObject({
      mode: 'resume',
    });
  });

  it('a live seat asks after the pick, and launches the picked harness', () => {
    let s = initialState(file([seat('ada', { harnesses: ['claude-code', 'codex'] })]), '', 1_000);
    s = reduce(s, {
      type: 'live',
      live: {
        'revive/agents/ada': { where: 'here', label: 'here', surface: 'claude-code', since: 1 },
      },
      status: 'ok',
      now: 1_000,
    }).state;
    const asked = press(s, key('return'), key('down'), key('return'));
    expect(asked.outcome).toBeNull();
    expect(asked.state.confirm).not.toBeNull();
    expect(press(asked.state, key('y')).outcome).toMatchObject({ harness: 'codex', force: true });
  });

  it('a human seat (a login shell) has no harness to pick', () => {
    const s = ok(initialState(file([seat('nick', { kind: 'human', harnesses: [] })]), '', 1_000));
    expect(press(s, key('return')).outcome).toMatchObject({ kind: 'launch', harness: null });
  });

  it('a seat with no recorded set still shows the one it would launch', () => {
    const s = ok(initialState(file([seat('old', { harnesses: [] })]), '', 1_000));
    expect(press(s, key('return')).state.choose?.options).toEqual(['claude-code']);
  });
});
