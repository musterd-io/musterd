import type { PickerRow, PickerView } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { initialPick, reducePick } from './state.js';
import { renderPickTable } from './table.js';
import { renderLanePicker } from './view.js';

// The exact no-color text of the `cmd/pick-*` frames in figma-brief-terminal.md.
const D = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 18);
const row = (id: string, title: string, over: Partial<PickerRow> = {}): PickerRow => ({
  id,
  short: id.slice(0, 10),
  title,
  detail: null,
  goal_id: 'find-work',
  areas: ['cli'],
  risk: [],
  scope: [],
  age_ms: 2 * D,
  blocked_on: [],
  declined: null,
  ...over,
});
const VIEW: PickerView = {
  seat: 'stanley',
  carrying: [],
  claimable: [
    {
      goal: 'find-work',
      rows: [
        row('01M5162QS1DP8JVVR93SMZ9N1B', 'musterd pick 3: CLI two-pane lane picker', {
          scope: ['packages/cli/src/pick/**'],
          detail: 'The terminal half of the picker.',
        }),
        row('01M5DT2PVNVF30FYGBKNXP4XDD', 'Board search: short ids that resolve', {
          age_ms: 5 * 3_600_000,
        }),
      ],
    },
    {
      goal: null,
      rows: [
        row('01M2H2N0Y6A5SVD9JCTH6SS27M', 'Decline a handoff and re-route it', {
          goal_id: null,
          areas: [],
          age_ms: 9 * D,
        }),
      ],
    },
  ],
  blocked: [
    {
      goal: 'launch',
      rows: [
        row('01M2H2MP1FW1AA9VJHM9SHG356', 'Two humans, two machines, one team', {
          goal_id: 'launch',
          areas: [],
          blocked_on: [
            { lane: '01M1T6DJ7J88WDZJXEY331VZ0V', owner: 'miley', detail: 'policy replication' },
          ],
        }),
      ],
    },
  ],
};
const HEAD = 'musterd pick — revive · for stanley   3 claimable · 1 blocked';
const FOOT = 'type to filter · ↑↓ move · tab claimable/blocked · ⏎ pick · esc quit';
const key = (name: string) => ({ type: 'key' as const, key: { name } });

describe('renderLanePicker (no color)', () => {
  const s0 = initialPick('revive', 'stanley', VIEW, NOW);

  it('cmd/pick-stacked — 80 columns, the brief under the list', () => {
    expect(renderLanePicker(s0, { cols: 80, rows: 16 })).toEqual([
      HEAD,
      'filter › ▏',
      'find-work',
      '▸ 01M5162QS1 musterd pick 3: CLI two-pane lane picker',
      '  01M5DT2PVN Board search: short ids that resolve',
      'no goal',
      '  01M2H2N0Y6 Decline a handoff and re-route it',
      '',
      '─'.repeat(80),
      '01M5162QS1',
      'musterd pick 3: CLI two-pane lane picker',
      '',
      'goal find-work · areas cli · opened 2026-10-18 (2d ago)',
      'scope packages/cli/src/pick/**',
      '',
      FOOT,
    ]);
  });

  it('cmd/pick-wide — 120 columns, the brief beside the list', () => {
    const bar = ' '.repeat(55) + '│';
    expect(renderLanePicker(s0, { cols: 120, rows: 12 })).toEqual([
      HEAD,
      'filter › ▏',
      'find-work                                              │ 01M5162QS1',
      '▸ 01M5162QS1 musterd pick 3: CLI two-pane lane picker  │ musterd pick 3: CLI two-pane lane picker',
      '  01M5DT2PVN Board search: short ids that resolve      │',
      'no goal                                                │ goal find-work · areas cli · opened 2026-10-18 (2d ago)',
      '  01M2H2N0Y6 Decline a handoff and re-route it         │ scope packages/cli/src/pick/**',
      bar,
      `${bar} The terminal half of the picker.`,
      bar,
      bar,
      FOOT,
    ]);
  });

  it('cmd/pick-blocked — tab, then ⏎ on a blocked lane: viewed, not picked', () => {
    const s = reducePick(reducePick(s0, key('tab')).state, key('return')).state;
    const out = renderLanePicker(s, { cols: 80, rows: 16 });
    expect(out[1]).toBe('blocked on 01M1T6DJ7J (owner miley) — it can be viewed, not picked');
    expect(out).toContain('▸ 01M2H2MP1F Two humans, two machines, one team');
    expect(out).toContain('blocked: policy replication');
  });

  it('under 60 columns it asks to be widened', () => {
    expect(renderLanePicker(s0, { cols: 59, rows: 16 })).toEqual([
      'widen the terminal to 60 columns · esc quits',
    ]);
  });
});

describe('cmd/pick-table — no TTY', () => {
  it('prints the board with full ids', () => {
    expect(renderPickTable(VIEW, 'revive')).toEqual([
      'musterd pick — revive · for stanley: 3 claimable, 1 blocked',
      '',
      'find-work:',
      '  01M5162QS1DP8JVVR93SMZ9N1B    2d  musterd pick 3: CLI two-pane lane picker [cli]',
      '  01M5DT2PVNVF30FYGBKNXP4XDD    5h  Board search: short ids that resolve [cli]',
      '',
      'no goal:',
      '  01M2H2N0Y6A5SVD9JCTH6SS27M    9d  Decline a handoff and re-route it',
      '',
      'blocked:',
      '',
      'launch:',
      '  01M2H2MP1FW1AA9VJHM9SHG356    2d  Two humans, two machines, one team',
      '      blocked on 01M1T6DJ7J (owner miley)',
    ]);
  });
});
