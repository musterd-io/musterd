import type { HuddleTrace } from '@musterd/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderHuddleTrace } from './huddleTrace.js';
import { setColorEnabled } from './theme.js';

/**
 * `musterd huddle show <id> --trace` (ADR 493): the room as one timeline. The frame is
 * docs/design/figma-brief-terminal.md §huddle trace; these pin its rows.
 */
const T0 = new Date(2026, 9, 1, 11, 23, 30).getTime();

const trace: HuddleTrace = {
  huddle: {
    id: '01M3WBAWCER121CB33TDPVDQ79',
    topic: 'goal:demo',
    anchor: 'docs/demo/options.md',
    opener: 'izzo',
    opened_at: T0,
    body: 'REHEARSAL 3',
    closed: { at: T0 + 425_000, by: 'izzo', anchor_ref: null },
  },
  seats: [
    {
      seat: 'izzo',
      harness: 'claude-code',
      summoned: 'opener',
      summoned_at: T0,
      summoned_by: 'R',
      wake: null,
      first_turn_at: T0,
      time_to_turn_ms: 0,
    },
    {
      seat: 'ryder',
      harness: 'claude-code',
      summoned: 'named',
      summoned_at: T0,
      summoned_by: 'R',
      wake: {
        lease_id: 'L2',
        leased_at: T0 + 35_000,
        spawned_at: null,
        session: 'fresh',
        outcome: 'woke',
        duration_ms: 44_200,
        cost_usd: 2.31,
      },
      first_turn_at: T0 + 336_000,
      time_to_turn_ms: 336_000,
    },
    {
      seat: 'miley',
      harness: 'claude-code',
      summoned: 'named',
      summoned_at: T0,
      summoned_by: 'R',
      wake: {
        lease_id: 'L1',
        leased_at: T0 + 35_000,
        spawned_at: null,
        session: 'resumed',
        outcome: 'woke',
        duration_ms: 27_485,
        cost_usd: 0.56,
      },
      first_turn_at: T0 + 84_000,
      time_to_turn_ms: 84_000,
    },
    {
      seat: 'lazara',
      harness: null,
      summoned: 'steered',
      summoned_at: T0 + 3_000,
      summoned_by: 'S',
      wake: null,
      first_turn_at: null,
      time_to_turn_ms: null,
    },
  ],
  events: [
    { ts: T0, seat: 'izzo', kind: 'act', label: 'message: REHEARSAL 3', act_id: 'R' },
    { ts: T0 + 50_000, seat: 'miley', kind: 'wake', label: 'woke · resumed' },
    {
      ts: T0 + 56_000,
      seat: 'miley',
      kind: 'tool',
      label: 'Bash',
      tool_name: 'Bash',
      outcome: 'ok',
      duration_ms: 11_000,
    },
    {
      ts: T0 + 62_000,
      seat: 'lazara',
      kind: 'hook',
      label: 'hook timeout',
      outcome: 'timeout',
      duration_ms: 10_000,
    },
    {
      ts: T0 + 84_000,
      seat: 'miley',
      kind: 'act',
      label: "message: I'd take lane 2",
      act_id: 'T1',
    },
  ],
  truncated: false,
};

describe('renderHuddleTrace', () => {
  beforeAll(() => setColorEnabled(false));
  afterAll(() => setColorEnabled(true));

  const out = () => renderHuddleTrace(trace, () => 'agent').split('\n');

  it('heads with the topic, state, id, and how long the room ran', () => {
    expect(out()[0]).toBe('huddle trace goal:demo closed · 01M3WBAWCE · 4 seats');
    expect(out()[1]).toBe('  opened by izzo 11:23:30 · closed 11:30:35 (7m 05s)');
  });

  it('lists seats fastest-to-speak first, silent seats last, with wake and time-to-turn', () => {
    const lines = out();
    const i = lines.findIndex((l) => l.startsWith('  seat'));
    expect(lines.slice(i, i + 5)).toEqual([
      '  seat      in as    wake                       harness      to turn',
      '  izzo      opener   —                          claude-code  —',
      '  miley     named    resumed · 27.5s · $0.56    claude-code  +1.4m',
      '  ryder     named    fresh · 44.2s · $2.31      claude-code  +5.6m',
      '  lazara    steered  —                          —            not yet',
    ]);
  });

  it('prints the timeline one event per line, clock first, tool outcome and duration inline', () => {
    const lines = out();
    expect(lines).toContain('  11:23:30  izzo      act    message: REHEARSAL 3');
    expect(lines).toContain('  11:24:26  miley     tool   Bash  ok 11.0s');
    expect(lines).toContain('  11:24:32  lazara    hook   hook timeout 10.0s');
    expect(lines).toContain("  11:24:54  miley     act    message: I'd take lane 2");
  });

  it('clips a long message to the terminal width, never wrapping the table', () => {
    const long = {
      ...trace,
      events: [{ ...trace.events[0]!, label: `message: ${'x'.repeat(200)}` }],
    };
    const line = renderHuddleTrace(long, () => 'agent', 80)
      .split('\n')
      .find((l) => l.includes('xxx'))!;
    expect(line.length).toBe(80);
    expect(line.endsWith('…')).toBe(true);
  });

  it('says when the timeline was cut', () => {
    const cut = renderHuddleTrace({ ...trace, truncated: true }, () => 'agent');
    expect(cut).toContain('timeline cut at 2000 events');
  });
});
