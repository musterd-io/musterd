import { describe, expect, it } from 'vitest';
import { EMPTY_LAUNCHER_FILE, type LauncherFile, type MemberEntry, type Seat } from '../store.js';
import { initialState, reduce, selectableRows, type Key, type PickerState } from './state.js';

/**
 * Inside a member workspace, bare `musterd` starts only that member (ADR 717). The recent screen
 * stays, so teams remain one key away. Enter on anyone else sets one line and launches nothing.
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
const file = (seats: Seat[]): LauncherFile => ({
  ...EMPTY_LAUNCHER_FILE,
  last: seats[0]!.address,
  seats: Object.fromEntries(
    seats.map((x, i) => [
      x.address,
      {
        path: x.path,
        harness: 'claude-code',
        mode: 'fresh' as const,
        launched_at: 900 - i,
        ended_at: null,
        exit: null,
      },
    ]),
  ),
  snapshot: { taken_at: 1_000, seats, teams: [{ team: 'revive', here: true }] },
});
const key = (name: string, extra: Partial<Key> = {}): { type: 'key'; key: Key } => ({
  type: 'key',
  key: { name, sequence: name.length === 1 ? name : undefined, ...extra },
});
const press = (s: PickerState, ...keys: ReturnType<typeof key>[]) => {
  let out = { state: s, outcome: null as ReturnType<typeof reduce>['outcome'] };
  for (const k of keys) out = reduce(out.state, k);
  return out;
};
const GHOST = { team: 'revive', member: 'ghost', root: '/w/ghost' };

const away = (member: string, over: Partial<MemberEntry> = {}): MemberEntry => ({
  team: 'revive',
  member,
  kind: 'agent',
  address: null,
  where: 'nowhere',
  node: null,
  where_label: null,
  can: 'setup',
  ...over,
});

describe('a member workspace scopes the launcher (ADR 717)', () => {
  it('opens an agent member on the harness step, with a row that changes the set', () => {
    const s = initialState(file([seat('stanley'), seat('ghost')]), '', 1_000, GHOST);
    expect(s.choose).toMatchObject({
      options: ['claude-code'],
      index: 0,
      change: true,
      mode: 'fresh',
    });
    expect(s.held).toBe(true);
    expect(s.choose?.seat.member).toBe('ghost');
    const configured = press(s, key('down'), key('return'));
    expect(configured.outcome).toMatchObject({ kind: 'configure', seat: { member: 'ghost' } });
    expect(press(s, key('return')).outcome).toMatchObject({
      kind: 'launch',
      harness: 'claude-code',
    });
  });

  it('esc returns to the list, and a later catalog does not reopen the step', () => {
    const seats = [seat('stanley'), seat('ghost')];
    const back = press(initialState(file(seats), '', 1_000, GHOST), key('escape'));
    expect(back.state.choose).toBeNull();
    expect(back.state.held).toBe(false);
    const again = reduce(back.state, {
      type: 'catalog',
      seats,
      teams: [{ team: 'revive', here: true }],
      stale: 0,
      now: 1_000,
    });
    expect(again.state.choose).toBeNull();
  });

  it('a catalog that arrives before the first key opens the step once the seat is in it', () => {
    const start = initialState(
      { ...EMPTY_LAUNCHER_FILE, snapshot: { taken_at: 0, seats: [], teams: [] } },
      '',
      1_000,
      GHOST,
    );
    expect(start.choose).toBeNull();
    expect(start.held).toBe(true);
    const pinned = reduce(start, {
      type: 'catalog',
      seats: [seat('ghost', { harnesses: ['claude-code', 'codex'] })],
      teams: [{ team: 'revive', here: true }],
      stale: 0,
      now: 1_000,
    });
    expect(pinned.state.choose).toMatchObject({
      options: ['claude-code', 'codex'],
      change: true,
    });
  });

  it('a key before that catalog keeps the list', () => {
    const start = initialState(
      { ...EMPTY_LAUNCHER_FILE, snapshot: { taken_at: 0, seats: [], teams: [] } },
      '',
      1_000,
      GHOST,
    );
    const typed = press(start, key('x'));
    expect(typed.state.held).toBe(false);
    expect(typed.state.query).toBe('x');
    const late = reduce(typed.state, {
      type: 'catalog',
      seats: [seat('ghost')],
      teams: [{ team: 'revive', here: true }],
      stale: 0,
      now: 1_000,
    });
    expect(late.state.choose).toBeNull();
  });

  it('lands on the harness just added once the catalog lists it', () => {
    const ghost = seat('ghost');
    let s = initialState(file([ghost]), '', 1_000, GHOST);
    s = { ...s, prefer: 'codex' };
    const next = reduce(s, {
      type: 'catalog',
      seats: [seat('ghost', { harnesses: ['claude-code', 'codex'] })],
      teams: [{ team: 'revive', here: true }],
      stale: 0,
      now: 1_000,
    });
    expect(next.state.choose).toMatchObject({ options: ['claude-code', 'codex'], index: 1 });
  });

  it('⏎ on another member sets one line and launches nothing; the next key clears it', () => {
    const back = press(
      initialState(file([seat('stanley'), seat('ghost')]), '', 1_000, GHOST),
      key('escape'),
    );
    const refused = press(back.state, key('return'));
    expect(refused.outcome).toBeNull();
    expect(refused.state.choose).toBeNull();
    expect(refused.state.notice).toBe('this folder is ghost — stanley starts from /w/stanley');
    expect(press(refused.state, key('up')).state.notice).toBeNull();
  });

  it('a human workspace stays the recent screen and ⏎ opens a login shell', () => {
    const ghost = seat('ghost', { kind: 'human', harnesses: [] });
    const s = initialState(file([ghost, seat('stanley')]), '', 1_000, GHOST);
    expect(s.choose).toBeNull();
    expect(selectableRows(s)[s.cursor]).toMatchObject({ kind: 'seat', seat: { member: 'ghost' } });
    expect(press(s, key('return')).outcome).toMatchObject({
      kind: 'launch',
      harness: null,
      seat: { member: 'ghost' },
    });
  });

  it('waking or setting up this member stays; another member and a new seat are refused', () => {
    const nick = seat('nick', { kind: 'human', harnesses: [] });
    const bo = away('bo', { where: 'node', node: 'n-air', where_label: 'air-2', can: 'wake' });
    const slate = away('slate');
    let s = initialState(file([nick, seat('ghost')]), '', 1_000, GHOST);
    s = reduce(s, {
      type: 'live',
      live: {},
      status: 'ok',
      now: 1_000,
      members: { revive: [bo, slate] },
    }).state;
    s = {
      ...s,
      choose: null,
      held: false,
      level: { kind: 'members', team: 'revive', project: 'agents' },
      stack: [{ kind: 'recent' }],
    };
    const at = (member: string) =>
      selectableRows(s).findIndex(
        (r) =>
          (r.kind === 'member' && r.entry.member === member) ||
          (r.kind === 'seat' && r.seat.member === member),
      );
    expect(press({ ...s, cursor: at('bo') }, key('return'))).toMatchObject({
      outcome: null,
      state: { notice: "this folder is ghost — bo starts from bo's own workspace", create: null },
    });
    expect(press({ ...s, cursor: at('slate') }, key('return')).state.create).toBeNull();
    expect(press({ ...s, cursor: at('slate') }, key('return')).state.notice).toContain('slate');
    const fresh = selectableRows(s).findIndex((r) => r.kind === 'new-seat');
    expect(press({ ...s, cursor: fresh }, key('return')).state.notice).toBe(
      'this folder is ghost — a new seat starts from a folder that is not a member workspace',
    );

    const own = { ...GHOST, member: 'bo' };
    let mine = initialState(file([nick]), '', 1_000, own);
    mine = reduce(mine, {
      type: 'live',
      live: {},
      status: 'ok',
      now: 1_000,
      members: { revive: [bo] },
    }).state;
    mine = {
      ...mine,
      level: { kind: 'members', team: 'revive', project: 'agents' },
      stack: [{ kind: 'recent' }],
      cursor: selectableRows({
        ...mine,
        level: { kind: 'members', team: 'revive', project: 'agents' },
      }).findIndex((r) => r.kind === 'member'),
    };
    expect(press(mine, key('return')).outcome).toEqual({ kind: 'wake', entry: bo });

    const setupScope = { ...GHOST, member: 'slate' };
    let setting = initialState(file([nick]), '', 1_000, setupScope);
    setting = reduce(setting, {
      type: 'live',
      live: {},
      status: 'ok',
      now: 1_000,
      members: { revive: [slate] },
    }).state;
    setting = {
      ...setting,
      level: { kind: 'members', team: 'revive', project: 'agents' },
      stack: [{ kind: 'recent' }],
      cursor: 1,
    };
    expect(selectableRows(setting)[1]).toMatchObject({
      kind: 'member',
      entry: { member: 'slate' },
    });
    expect(press(setting, key('return')).state.create).toMatchObject({
      member: 'slate',
      naming: false,
    });
  });

  it('→ still opens teams', () => {
    const back = press(initialState(file([seat('ghost')]), '', 1_000, GHOST), key('escape'));
    expect(press(back.state, key('right')).state.level).toEqual({ kind: 'teams' });
  });
});
