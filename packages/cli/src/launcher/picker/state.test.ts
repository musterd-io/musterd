import { describe, expect, it } from 'vitest';
import { EMPTY_LAUNCHER_FILE, type LauncherFile, type Seat } from '../store.js';
import { initialState, reduce, rows, selectableRows, type Key, type PickerState } from './state.js';

const seat = (address: string, over: Partial<Seat> = {}): Seat => {
  const [team, project, member] = address.split('/') as [string, string, string];
  return {
    address,
    team,
    project,
    member,
    server: 'http://127.0.0.1:4849',
    path: `/w/${member}`,
    kind: 'agent',
    harnesses: ['claude-code', 'codex'],
    remote: null,
    last_session: null,
    problem: null,
    ...over,
  };
};
const SEATS = [seat('revive/agents/stanley'), seat('revive/agents/miley'), seat('dawn/web/ada')];
const FILE: LauncherFile = {
  ...EMPTY_LAUNCHER_FILE,
  last: 'revive/agents/stanley',
  seats: {
    'revive/agents/stanley': {
      path: '/w/stanley',
      harness: 'claude-code',
      mode: 'fresh',
      launched_at: 900,
      ended_at: null,
      exit: null,
    },
    'revive/agents/miley': {
      path: '/w/miley',
      harness: 'claude-code',
      mode: 'fresh',
      launched_at: 800,
      ended_at: null,
      exit: null,
    },
  },
  snapshot: {
    taken_at: 1,
    seats: SEATS,
    teams: [
      { team: 'acme', here: false },
      { team: 'dawn', here: true },
      { team: 'revive', here: true },
    ],
  },
};
const k = (name: string, extra: Partial<Key> = {}): Key => ({
  name,
  sequence: name.length === 1 ? name : undefined,
  ...extra,
});
function press(s: PickerState, ...keys: Key[]) {
  let state = s;
  for (const key of keys) {
    const r = reduce(state, { type: 'key', key });
    if (r.outcome) return { state: r.state, outcome: r.outcome };
    state = r.state;
  }
  return { state, outcome: null };
}

describe('picker state (spec §3)', () => {
  const s0 = initialState(FILE, '', 1_000);

  it('opens on recent seats, newest first, from the snapshot', () => {
    expect(rows(s0)[0]).toEqual({ kind: 'heading', label: 'recent' });
    expect(selectableRows(s0).map((r) => (r.kind === 'seat' ? r.seat.member : ''))).toEqual([
      'stanley',
      'miley',
    ]);
  });

  it('⏎ launches the selected seat fresh; ⌃R resumes', () => {
    expect(press(s0, k('return')).outcome).toEqual({
      kind: 'launch',
      seat: SEATS[0],
      mode: 'fresh',
      harness: null,
      force: false,
    });
    expect(press(s0, k('down'), k('r', { ctrl: true })).outcome).toMatchObject({
      seat: SEATS[1],
      mode: 'resume',
    });
  });

  it('typing searches every seat; esc clears, then quits', () => {
    const { state } = press(s0, k('a'), k('d'));
    expect(state.query).toBe('ad');
    expect(selectableRows(state).map((r) => (r.kind === 'seat' ? r.seat.member : ''))).toEqual([
      'ada',
    ]);
    const cleared = press(state, k('escape')).state;
    expect(cleared.query).toBe('');
    expect(press(cleared, k('escape')).outcome).toEqual({ kind: 'quit', code: 0 });
  });

  it('`r` and `q` are letters, not commands — `ryder` must be typeable', () => {
    expect(press(s0, k('r'), k('q')).state.query).toBe('rq');
  });

  it('⌃C quits 130 from anywhere', () => {
    expect(press(s0, k('a'), k('c', { ctrl: true })).outcome).toEqual({ kind: 'quit', code: 130 });
  });

  it('→ browses teams → projects → members; ← goes back; a team with no Workspace is skipped', () => {
    let { state } = press(s0, k('right'));
    expect(state.level).toEqual({ kind: 'teams' });
    expect(selectableRows(state).map((r) => (r.kind === 'team' ? r.team : ''))).toEqual([
      'dawn',
      'revive',
    ]);
    state = press(state, k('down'), k('return')).state;
    expect(state.level).toEqual({ kind: 'projects', team: 'revive' });
    state = press(state, k('return')).state;
    expect(state.level).toEqual({ kind: 'members', team: 'revive', project: 'agents' });
    expect(selectableRows(state).map((r) => (r.kind === 'seat' ? r.seat.member : ''))).toEqual([
      'miley',
      'stanley',
    ]);
    expect(press(state, k('left')).state.level).toEqual({ kind: 'projects', team: 'revive' });
  });

  it('⇥ cycles the harness on a seat with several, and the launch carries it', () => {
    const { state } = press(s0, k('tab'));
    expect(state.harness['revive/agents/stanley']).toBe('codex');
    expect(press(state, k('return')).outcome).toMatchObject({ harness: 'codex' });
  });

  it('a live seat asks first; y launches with force, anything else cancels', () => {
    const live = reduce(s0, {
      type: 'live',
      live: {
        'revive/agents/stanley': { where: 'here', label: 'here', surface: 'claude-code', since: 5 },
      },
      status: 'ok',
      now: 2_000,
    }).state;
    const asking = press(live, k('return')).state;
    expect(asking.confirm?.seat).toEqual(SEATS[0]);
    expect(press(asking, k('n')).state.confirm).toBeNull();
    expect(press(asking, k('y')).outcome).toEqual({
      kind: 'launch',
      seat: SEATS[0],
      mode: 'fresh',
      harness: null,
      force: true,
    });
  });

  it('when the roster answered, a launch skips the re-check', () => {
    const ok = reduce(s0, { type: 'live', live: {}, status: 'ok', now: 2_000 }).state;
    expect(press(ok, k('return')).outcome).toMatchObject({ force: true });
  });

  it('a fresh catalog keeps the cursor on the same seat', () => {
    const moved = press(s0, k('down')).state;
    const next = reduce(moved, {
      type: 'catalog',
      seats: [seat('revive/agents/zed'), ...SEATS],
      teams: [],
      stale: 0,
      now: 3_000,
    }).state;
    const sel = selectableRows(next)[next.cursor];
    expect(sel?.kind === 'seat' && sel.seat.member).toBe('miley');
    expect(next.scanning).toBe(false);
  });
});
