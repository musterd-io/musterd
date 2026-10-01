import { describe, expect, it } from 'vitest';
import { sinceLabel } from '../render/theme.js';
import {
  ago,
  describeLive,
  describeLiveLong,
  formatDuration,
  formatReceipt,
  renderSeatsList,
  seatLine,
} from './rows.js';
import type { Seat } from './store.js';

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

describe('launcher rows (ADR 491)', () => {
  it('ago / duration', () => {
    expect([
      ago(NOW - 30_000, NOW),
      ago(NOW - 5 * 60_000, NOW),
      ago(NOW - 2 * H, NOW),
      ago(NOW - 26 * H, NOW),
    ]).toEqual(['now', '5m', '2h', '1d']);
    expect([
      formatDuration(9_000),
      formatDuration(42 * 60_000),
      formatDuration(125 * 60_000),
    ]).toEqual(['9s', '42m', '2h 5m']);
  });

  it('the receipt is one line', () => {
    expect(formatReceipt('stanley', 'claude-code', 42 * 60_000, 0)).toBe(
      '✓ stanley · claude · 42m · exit 0 · musterd - to go back',
    );
    expect(formatReceipt('stanley', 'codex', 9_000, 7)).toBe(
      '✗ stanley · codex · 9s · exit 7 · musterd - to go back',
    );
  });

  it('describes where a seat is live', () => {
    const here = { where: 'here' as const, label: 'here', surface: 'claude-code', since: NOW - H };
    expect(describeLive(here, NOW)).toBe(`here · since ${sinceLabel(NOW - H, NOW)}`);
    expect(describeLiveLong({ ...here, where: 'elsewhere', label: 'mini-2' }, NOW)).toBe(
      `on mini-2 (claude-code) since ${sinceLabel(NOW - H, NOW)}`,
    );
  });

  it('a seat line, with and without the address and harness columns', () => {
    const s = seat('stanley');
    expect(
      seatLine(s, {
        selected: true,
        nameWidth: 9,
        addressWidth: 15,
        showHarness: true,
        harness: 'claude-code',
        state: 'idle',
        tail: '★ last used · 2h',
      }),
    ).toBe('› stanley  revive/agents  claude   ○ idle  ★ last used · 2h');
    expect(
      seatLine(s, {
        selected: false,
        nameWidth: 9,
        addressWidth: null,
        showHarness: false,
        harness: 'claude-code',
        state: 'live',
        tail: 'here',
      }),
    ).toBe('  stanley  ● live  here');
    expect(
      seatLine(seat('nick', { kind: 'human' }), {
        selected: false,
        nameWidth: 9,
        addressWidth: null,
        showHarness: true,
        harness: 'human',
        state: 'unknown',
        tail: '',
      }),
    ).toBe('  nick     human    ?');
  });

  it('`musterd seats` groups by team/project', () => {
    const out = renderSeatsList(
      [
        { seat: seat('stanley'), live: null, lastUsed: NOW - 2 * H },
        {
          seat: seat('miley'),
          live: { where: 'here', label: 'here', surface: 'claude-code', since: NOW - H },
          lastUsed: null,
        },
        {
          seat: seat('gptbot', {
            harnesses: ['codex'],
            problem: { kind: 'binding-invalid', fix: 'x' },
          }),
          live: null,
          lastUsed: null,
        },
      ],
      2,
      NOW,
    );
    expect(out).toBe(
      [
        'seats on this machine · 3',
        '',
        'revive/agents',
        '  stanley  claude   ○ idle  2h',
        `  miley    claude   ● live  here · since ${sinceLabel(NOW - H, NOW)}`,
        '  gptbot   codex    ○ idle  needs repair',
        '',
        '2 stale · musterd init --prune-bindings --apply',
      ].join('\n'),
    );
  });
});
