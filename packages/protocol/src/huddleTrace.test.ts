import { describe, expect, it } from 'vitest';
import {
  HUDDLE_TRACE_EVENT_KINDS,
  HUDDLE_TRACE_MAX_EVENTS,
  HuddleTraceSchema,
  type HuddleTrace,
} from './huddleTrace.js';

const sample: HuddleTrace = {
  huddle: {
    id: '01M3WBAWCER121CB33TDPVDQ79',
    topic: 'goal:demo',
    anchor: 'docs/demo/options.md',
    opener: 'izzo',
    opened_at: 1_790_879_010_000,
    body: 'REHEARSAL 3',
    closed: { at: 1_790_879_435_000, by: 'izzo', anchor_ref: 'none' },
  },
  seats: [
    {
      seat: 'miley',
      harness: 'claude-code',
      summoned: 'named',
      summoned_at: 1_790_879_010_000,
      summoned_by: '01M3WBAWCER121CB33TDPVDQ79',
      wake: {
        lease_id: '01M3WBB5YRR0TNW2H77CA595KX',
        leased_at: 1_790_879_045_593,
        spawned_at: null,
        session: 'resumed',
        outcome: 'woke',
        duration_ms: 27_485,
        cost_usd: 0.56,
      },
      first_turn_at: 1_790_879_081_124,
      time_to_turn_ms: 71_124,
    },
  ],
  events: [
    {
      ts: 1_790_879_010_000,
      seat: 'izzo',
      kind: 'act',
      label: 'message: REHEARSAL 3',
      act_id: '01M3WBAWCER121CB33TDPVDQ79',
    },
    {
      ts: 1_790_879_064_000,
      seat: 'miley',
      kind: 'tool',
      label: 'Bash',
      tool_name: 'Bash',
      outcome: 'ok',
      duration_ms: 11_000,
    },
  ],
  truncated: false,
};

describe('HuddleTraceSchema (ADR 493)', () => {
  it('round-trips a trace with a woken seat, an act and a tool step', () => {
    expect(HuddleTraceSchema.parse(sample)).toEqual(sample);
  });

  it('accepts a seat that was never woken (attended in a terminal) and has not spoken yet', () => {
    const seat = { ...sample.seats[0]!, wake: null, first_turn_at: null, time_to_turn_ms: null };
    expect(HuddleTraceSchema.parse({ ...sample, seats: [seat] }).seats[0]!.wake).toBeNull();
  });

  it('refuses an event kind outside act | wake | tool | hook | session', () => {
    expect(HUDDLE_TRACE_EVENT_KINDS).toEqual(['act', 'wake', 'tool', 'hook', 'session']);
    const bad = { ...sample, events: [{ ...sample.events[0]!, kind: 'content' }] };
    expect(HuddleTraceSchema.safeParse(bad).success).toBe(false);
  });

  it('has no field that could carry tool content', () => {
    const withContent = {
      ...sample,
      events: [{ ...sample.events[1]!, content: { command: 'cat ~/.ssh/id_rsa' } }],
    };
    const parsed = HuddleTraceSchema.parse(withContent);
    expect(parsed.events[0]).not.toHaveProperty('content');
  });

  it('caps the event list at HUDDLE_TRACE_MAX_EVENTS', () => {
    const many = Array.from({ length: HUDDLE_TRACE_MAX_EVENTS + 1 }, () => sample.events[0]!);
    expect(HuddleTraceSchema.safeParse({ ...sample, events: many }).success).toBe(false);
  });
});
