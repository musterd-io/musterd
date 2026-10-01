import { describe, expect, it } from 'vitest';
import { sinceLabel } from '../../render/theme.js';
import { EMPTY_LAUNCHER_FILE, type LauncherFile, type Seat } from '../store.js';
import { initialState, reduce } from './state.js';
import { renderPicker } from './view.js';

const NOW = Date.UTC(2026, 9, 1, 18, 0, 0);
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
      '',
      '  ⏎ launch · ⌃R resume · type to search · → browse · esc quit',
    ]);
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
    s = reduce(s, { type: 'key', key: { name: 'return' } }).state;
    const lines = renderPicker(s, { cols: 80, rows: 24 });
    // Wrapped to the width, never clipped: the `(y/N)` must stay visible.
    expect(lines.slice(-2)).toEqual([
      `  stanley is live here (claude-code) since ${sinceLabel(NOW - H, NOW)}. Open a second session in the`,
      '  same folder? (y/N)',
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
});
