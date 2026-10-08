import { describe, expect, it } from 'vitest';
import { sinceLabel } from '../../render/theme.js';
import { EMPTY_LAUNCHER_FILE, type LauncherFile, type Seat } from '../store.js';
import { initialState, reduce } from './state.js';
import { renderPicker } from './view.js';

const NOW = Date.UTC(2026, 9, 1, 18, 0, 0);
const key = (name: string) => ({ type: 'key' as const, key: { name } });
const H = 3_600_000;
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
const SEATS = [
  seat('stanley'),
  seat('miley', {
    last_session: { harness: 'claude-code', started_at: NOW - 3 * H, ended_at: null },
  }),
  seat('gptbot', {
    harnesses: ['codex'],
    last_session: { harness: 'codex', started_at: NOW - 26 * H, ended_at: null },
  }),
];
const FILE: LauncherFile = {
  ...EMPTY_LAUNCHER_FILE,
  last: 'revive/agents/stanley',
  seats: {
    'revive/agents/stanley': {
      path: '/w/stanley',
      harness: 'claude-code',
      mode: 'fresh',
      launched_at: NOW - 2 * H,
      ended_at: null,
      exit: null,
    },
  },
  snapshot: { taken_at: NOW, seats: SEATS, teams: [{ team: 'revive', here: true }] },
};
const header = (left: string, right: string) =>
  left + ' '.repeat(80 - left.length - right.length) + right;

describe('renderPicker (spec §3.1, no color, 80 columns)', () => {
  it('the recent screen, once the roster answered', () => {
    let s = initialState(FILE, '', NOW);
    s = reduce(s, {
      type: 'catalog',
      seats: SEATS,
      teams: [{ team: 'revive', here: true }],
      stale: 0,
      now: NOW,
    }).state;
    s = reduce(s, {
      type: 'live',
      live: {
        'revive/agents/miley': {
          where: 'here',
          label: 'here',
          surface: 'claude-code',
          since: NOW - H,
        },
      },
      status: 'ok',
      now: NOW,
    }).state;
    expect(renderPicker(s, { cols: 80, rows: 24 })).toEqual([
      header('● ● ○ musterd', 'revive · 3 seats here'),
      '',
      '  recent',
      '› stanley  revive/agents  claude   ○ idle  ★ last used · 2h',
      `  miley    revive/agents  claude   ● live  here · since ${sinceLabel(NOW - H, NOW)}`,
      '  gptbot   revive/agents  codex    ○ idle  1d',
      '  teams',
      '  revive   ● here  3 seats  ★',
      '',
      '  ⏎ launch · ⌃R resume · type to search · → teams · esc quit',
    ]);
    // On the team row the footer says what ⏎ does there (ADR 540).
    const onTeam = reduce(
      reduce(reduce(s, key('down')).state, key('down')).state,
      key('down'),
    ).state;
    const lines = renderPicker(onTeam, { cols: 80, rows: 24 });
    expect(lines[lines.length - 1]).toBe('  ⏎ open · type to search · → teams · esc quit');
    expect(lines).toContain('› revive   ● here  3 seats  ★');
  });

  it('says it is still checking before the roster answers, and offline when it cannot', () => {
    const s = initialState(FILE, '', NOW);
    expect(renderPicker(s, { cols: 80, rows: 24 })[0]).toBe(
      header('● ● ○ musterd', 'revive · 3 seats here · checking…'),
    );
    const off = reduce(s, { type: 'live', live: {}, status: 'offline', now: NOW }).state;
    expect(renderPicker(off, { cols: 80, rows: 24 })[0]).toContain(
      'offline · live state unavailable',
    );
    expect(renderPicker(off, { cols: 80, rows: 24 })[3]).toContain('?');
  });

  it('drops the address column below 70 columns and the harness column below 56', () => {
    const s = reduce(initialState(FILE, '', NOW), {
      type: 'live',
      live: {},
      status: 'ok',
      now: NOW,
    }).state;
    expect(renderPicker(s, { cols: 60, rows: 24 })[3]).toBe(
      '› stanley  claude   ○ idle  ★ last used · 2h',
    );
    expect(renderPicker(s, { cols: 50, rows: 24 })[3]).toBe('› stanley  ○ idle  ★ last used · 2h');
  });

  it('the live-seat prompt replaces the footer', () => {
    let s = initialState(FILE, '', NOW);
    s = reduce(s, {
      type: 'live',
      live: {
        'revive/agents/stanley': {
          where: 'here',
          label: 'here',
          surface: 'claude-code',
          since: NOW - H,
        },
      },
      status: 'ok',
      now: NOW,
    }).state;
    s = reduce(s, { type: 'key', key: { name: 'return' } }).state; // the harness step
    s = reduce(s, { type: 'key', key: { name: 'return' } }).state; // pick → the live question
    const lines = renderPicker(s, { cols: 80, rows: 24 });
    // Wrapped to the width, never clipped: the `(y/N)` must stay visible.
    expect(lines.slice(-2)).toEqual([
      `  stanley is live here (claude-code) since ${sinceLabel(NOW - H, NOW)}. Open a second session in the`,
      '  same folder? (y/N)',
    ]);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(80);
  });

  it('a live wake shows the take over / watch menu in the footer (ADR 546)', () => {
    let s = initialState(FILE, '', NOW);
    s = reduce(s, {
      type: 'live',
      live: {
        'revive/agents/stanley': {
          where: 'here',
          label: 'here',
          surface: 'claude-code',
          since: NOW - H,
          wake: {
            edge: 'dispatch_continuation',
            lane_id: '01M46YWG8YHEV2SKW9F1N0W8FG',
            act_id: null,
            act: null,
            from: null,
          },
        },
      },
      status: 'ok',
      now: NOW,
    }).state;
    s = reduce(s, key('return')).state;
    s = reduce(s, key('return')).state;
    const lines = renderPicker(s, { cols: 80, rows: 24 });
    expect(lines.slice(-4)).toEqual([
      `  stanley is busy — a wake started ${sinceLabel(NOW - H, NOW)} to carry on with lane 01M46YWG8Y.`,
      '    ⏎  take over   stop the wake, continue its conversation here',
      '    w  watch       follow it live; ⏎ takes over at any point',
      '    esc cancel',
    ]);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(80);
  });

  it('never prints a line wider than the terminal, and fits the height', () => {
    const many = Array.from({ length: 60 }, (_, i) => seat(`member-with-a-long-name-${i}`));
    const s = initialState(
      { ...FILE, snapshot: { taken_at: NOW, seats: many, teams: [] } },
      '',
      NOW,
    );
    const lines = renderPicker(s, { cols: 40, rows: 12 });
    expect(lines.length).toBeLessThanOrEqual(12);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(40);
  });

  it('first run, before any scan, says it is finding seats', () => {
    const s = initialState(EMPTY_LAUNCHER_FILE, '', NOW);
    expect(renderPicker(s, { cols: 80, rows: 24 })).toContain('  finding seats…');
  });

  it('the set-up prompt names the path and the harness', () => {
    let s = initialState(
      {
        ...FILE,
        snapshot: {
          taken_at: NOW,
          seats: [...SEATS, seat('nick', { kind: 'human' })],
          teams: [{ team: 'revive', here: true }],
        },
      },
      '',
      NOW,
    );
    s = reduce(s, {
      type: 'live',
      live: {},
      status: 'ok',
      now: NOW,
      members: {
        revive: [
          {
            team: 'revive',
            member: 'slate',
            kind: 'agent',
            address: null,
            where: 'nowhere',
            node: null,
            where_label: null,
            can: 'setup',
          },
        ],
      },
    }).state;
    s = {
      ...s,
      level: { kind: 'members', team: 'revive', project: 'agents' },
      create: {
        team: 'revive',
        project: 'agents',
        member: 'slate',
        naming: false,
        harness: 2,
        error: null,
      },
    };
    expect(renderPicker(s, { cols: 120, rows: 24 }).at(-1)).toBe(
      '  set up slate here → ~/musterd/revive/agents/slate · codex (⇥ to change) · ⏎ set up and launch · esc cancel',
    );
  });

  it('the harness step names how many are configured, even one, and which was used last', () => {
    let s = initialState(FILE, '', NOW);
    s = reduce(s, { type: 'live', live: {}, status: 'ok', now: NOW }).state;
    s = reduce(s, { type: 'key', key: { name: 'return' } }).state;
    const one = { ...s.choose!, options: ['claude-code'], index: 0 };
    expect(renderPicker({ ...s, choose: one }, { cols: 80, rows: 24 }).slice(-3)).toEqual([
      '  stanley · 1 harness configured',
      '  › claude    last used',
      '  ⏎ launch · ↑↓ choose · esc back',
    ]);
    const two = { ...s.choose!, options: ['claude-code', 'codex'], index: 1 };
    expect(renderPicker({ ...s, choose: two }, { cols: 80, rows: 24 }).slice(-4)).toEqual([
      '  stanley · 2 harnesses configured',
      '    claude    last used',
      '  › codex',
      '  ⏎ launch · ↑↓ choose · esc back',
    ]);
  });
});

describe('roster-first rows in the picker (ADR 503 Decision 3)', () => {
  const entry = (member: string, over: Record<string, unknown>) => ({
    team: 'revive',
    member,
    kind: 'agent' as const,
    address: null,
    where: 'nowhere' as const,
    node: null,
    where_label: null,
    can: 'setup' as const,
    ...over,
  });
  function membersLevel() {
    let s = initialState(
      {
        ...FILE,
        snapshot: {
          taken_at: NOW,
          seats: [seat('stanley'), seat('nick', { kind: 'human' })],
          teams: [{ team: 'revive', here: true }],
        },
      },
      '',
      NOW,
    );
    s = reduce(s, {
      type: 'live',
      live: {},
      status: 'ok',
      now: NOW,
      members: {
        revive: [
          entry('stanley', {
            address: 'revive/agents/stanley',
            where: 'node',
            node: 'n-air',
            where_label: 'air-2',
            can: 'none',
          }),
          entry('bo', { where: 'node', node: 'n-air', where_label: 'air-2', can: 'wake' }),
          entry('cy', { where: 'cloud', node: 'n-fly', where_label: 'fly', can: 'none' }),
          entry('slate', {}),
        ],
      },
    }).state;
    return {
      ...s,
      level: { kind: 'members', team: 'revive', project: 'agents' } as const,
      stack: [{ kind: 'recent' as const }],
    };
  }

  it('headings read `on this machine` / `on the team`; each away row shows where and the dimmed verb', () => {
    const lines = renderPicker(membersLevel(), { cols: 80, rows: 24 }).map((l) => l.trimEnd());
    expect(lines).toContain('  on this machine');
    expect(lines).toContain('  on the team');
    expect(lines.some((l) => /bo\s+on air-2\s+wake$/.test(l))).toBe(true);
    expect(lines.some((l) => /cy\s+cloud · fly$/.test(l))).toBe(true);
    expect(lines.some((l) => /slate\s+nowhere\s+set up$/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain('not here');
  });

  it('a Workspace here whose seat lives elsewhere says so on its own row', () => {
    const lines = renderPicker(membersLevel(), { cols: 100, rows: 24 });
    expect(lines.some((l) => l.includes('stanley') && l.includes('on air-2'))).toBe(true);
  });

  it('the footer on a `none` row names the node and the move ceremony; on a wake row, the doorbell', () => {
    const s = membersLevel();
    // selectable (here sorted by member): nick, stanley, bo, cy, slate, + new seat
    const onStanley = renderPicker({ ...s, cursor: 1 }, { cols: 120, rows: 24 }).at(-1);
    expect(onStanley).toBe(
      '  resident on air-2 — move it: musterd residency off + node unbind there',
    );
    const onBo = renderPicker({ ...s, cursor: 2 }, { cols: 120, rows: 24 }).at(-1);
    expect(onBo).toContain('⏎ wake');
    const onCy = renderPicker({ ...s, cursor: 3 }, { cols: 120, rows: 24 }).at(-1);
    expect(onCy).toBe(
      '  resident in the cloud — move it: musterd residency off + node unbind there',
    );
  });
});

describe('frames (figma-brief-terminal.md, ADR 503 inc 4 — no color, 80 columns)', () => {
  const entry = (member: string, over: Record<string, unknown>) => ({
    team: 'revive',
    member,
    kind: 'agent' as const,
    address: null,
    where: 'nowhere' as const,
    node: null,
    where_label: null,
    can: 'setup' as const,
    ...over,
  });
  function teamLevel() {
    let s = initialState(
      {
        ...FILE,
        snapshot: {
          taken_at: NOW,
          seats: [seat('stanley'), seat('nick', { kind: 'human' })],
          teams: [{ team: 'revive', here: true }],
        },
      },
      '',
      NOW,
    );
    s = reduce(s, {
      type: 'live',
      live: {},
      status: 'ok',
      now: NOW,
      members: {
        revive: [
          entry('stanley', {
            address: 'revive/agents/stanley',
            where: 'here',
            node: 'n-hub',
            can: 'launch',
          }),
          entry('nick', {
            kind: 'human',
            address: 'revive/agents/nick',
            where: 'here',
            node: 'n-hub',
            can: 'launch',
          }),
          entry('bo', { where: 'node', node: 'n-air', where_label: 'air-2', can: 'wake' }),
          entry('cy', { where: 'node', node: 'n-air', where_label: 'air-2', can: 'none' }),
          entry('slate', {}),
        ],
      },
    }).state;
    return {
      ...s,
      level: { kind: 'members', team: 'revive', project: 'agents' } as const,
      stack: [{ kind: 'recent' as const }],
    };
  }

  it('cmd/launcher-team — the members level, every member once under two headings', () => {
    expect(renderPicker(teamLevel(), { cols: 80, rows: 24 })).toEqual([
      header('● ● ○ musterd › revive › agents', 'revive · 2 seats here'),
      '',
      '  on this machine',
      '› nick     human    ○ idle',
      '  stanley  claude   ○ idle  ★ last used · 2h',
      '  on the team',
      '  bo       on air-2  wake',
      '  cy       on air-2',
      '  slate    nowhere  set up',
      '  + new seat',
      '',
      '  ⏎ launch · ⌃R resume · ⇥ harness · ← back · esc back',
    ]);
  });

  it('cmd/launcher-team-none — the footer on a seat resident elsewhere that is not yours to wake', () => {
    // selectable: nick, stanley, bo, cy, slate, + new seat
    expect(renderPicker({ ...teamLevel(), cursor: 3 }, { cols: 80, rows: 24 }).slice(-1)).toEqual([
      '  resident on air-2 — move it: musterd residency off + node unbind there',
    ]);
  });

  it('cmd/launcher-team-wake — the footer on a wake row', () => {
    expect(renderPicker({ ...teamLevel(), cursor: 2 }, { cols: 80, rows: 24 }).slice(-1)).toEqual([
      '  ⏎ wake — rings its doorbell (a steer, as you) · ← back · esc back',
    ]);
  });
});
