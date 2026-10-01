import type { Envelope } from '@musterd/protocol';
import { HuddleTraceSchema } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { assembleHuddleTrace, type HuddleAuditRow, type HuddleTraceRow } from './huddleTrace.js';

const T0 = 1_790_879_010_000;
const ROOT = '01M3WBAWCER121CB33TDPVDQ79';
const STEER = '01M3WBAZMYHQWB3RSVR21GGZK7';

function env(over: Partial<Envelope> & Pick<Envelope, 'id' | 'from' | 'act' | 'ts'>): Envelope {
  return {
    v: '0.1.0',
    team: 'revive',
    to: { kind: 'team' },
    body: '',
    thread: ROOT,
    meta: null,
    received_at: over.ts,
    ...over,
  } as Envelope;
}

const root = env({
  id: ROOT,
  from: 'izzo',
  act: 'message',
  ts: T0,
  thread: null,
  body: 'REHEARSAL 3: say which Replay lane you would take',
  meta: {
    huddle: { topic: { kind: 'goal', id: 'demo' }, anchor: 'docs/demo/options.md' },
    eligible: ['izzo', 'miley', 'ryder'],
  },
});
const steer = env({
  id: STEER,
  from: 'izzo',
  act: 'steer',
  ts: T0 + 3_000,
  to: { kind: 'member', name: 'lazara' },
  body: 'you are in the huddle',
});
const mileyTurn = env({ id: 'T1', from: 'miley', act: 'message', ts: T0 + 71_000, body: 'lane 2' });
const close = env({
  id: 'C1',
  from: 'izzo',
  act: 'resolve',
  ts: T0 + 400_000,
  body: 'PASS',
  meta: { anchor_ref: 'none' },
});
const unrelated = env({ id: 'X1', from: 'ghost', act: 'message', ts: T0 + 5, thread: 'OTHER' });

const audit: HuddleAuditRow[] = [
  {
    ts: T0 + 35_000,
    action: 'residency.wake_leased',
    target: 'miley',
    detail: { lease_id: 'L1', act: ROOT },
  },
  {
    ts: T0 + 50_000,
    action: 'residency.session_captured',
    target: 'miley',
    detail: { harness: 'claude-code', session_digest: 'abc', wake_lease: 'L1' },
  },
  {
    ts: T0 + 57_000,
    action: 'residency.woke',
    target: 'miley',
    detail: { act: ROOT, lease_id: 'L1', session: 'resumed' },
  },
  {
    ts: T0 + 80_000,
    action: 'residency.wake_cost',
    target: 'miley',
    detail: { act: ROOT, lease_id: 'L1', cost_usd: 0.56, duration_ms: 27_485 },
  },
  {
    ts: T0 + 36_000,
    action: 'residency.wake_leased',
    target: 'lazara',
    detail: { lease_id: 'L2', act: STEER },
  },
  // A wake for an act outside this huddle — must not attach to the seat.
  {
    ts: T0 + 37_000,
    action: 'residency.wake_leased',
    target: 'ryder',
    detail: { lease_id: 'L9', act: 'OTHER' },
  },
];

const trace: HuddleTraceRow[] = [
  {
    ts: T0 + 60_000,
    seat: 'miley',
    harness: 'claude-code',
    kind: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'u1',
    outcome: null,
    duration_ms: null,
  },
  {
    ts: T0 + 61_000,
    seat: 'miley',
    harness: 'claude-code',
    kind: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'u1',
    outcome: 'ok',
    duration_ms: 1_000,
  },
  {
    ts: T0 + 62_000,
    seat: 'lazara',
    harness: 'codex',
    kind: 'HookOutcome',
    tool_name: null,
    tool_use_id: null,
    outcome: 'timeout',
    duration_ms: 10_000,
  },
  {
    ts: T0 + 63_000,
    seat: 'lazara',
    harness: 'codex',
    kind: 'HookOutcome',
    tool_name: null,
    tool_use_id: null,
    outcome: 'ok',
    duration_ms: 20,
  },
  {
    ts: T0 + 64_000,
    seat: 'lazara',
    harness: 'codex',
    kind: 'reasoning',
    tool_name: null,
    tool_use_id: null,
    outcome: null,
    duration_ms: null,
  },
  {
    ts: T0 + 65_000,
    seat: 'ryder',
    harness: 'claude-code',
    kind: 'PreToolUse',
    tool_name: 'Grep',
    tool_use_id: null,
    outcome: null,
    duration_ms: null,
  },
  // Outside the window (after the close) — dropped.
  {
    ts: T0 + 500_000,
    seat: 'miley',
    harness: 'claude-code',
    kind: 'PostToolUse',
    tool_name: 'Read',
    tool_use_id: 'u2',
    outcome: 'ok',
    duration_ms: 5,
  },
];

const build = () =>
  assembleHuddleTrace({
    thread: [root, steer, mileyTurn, close, unrelated],
    audit,
    spawnedAt: new Map([['L1', T0 + 40_000]]),
    trace,
    now: T0 + 900_000,
  });

describe('assembleHuddleTrace (ADR 493)', () => {
  it('returns null when the root is not a huddle', () => {
    expect(
      assembleHuddleTrace({
        thread: [unrelated],
        audit: [],
        spawnedAt: new Map(),
        trace: [],
        now: T0,
      }),
    ).toBeNull();
  });

  it('answers a schema-valid trace with the header and the close', () => {
    const t = build()!;
    expect(HuddleTraceSchema.parse(t)).toEqual(t);
    expect(t.huddle).toMatchObject({ id: ROOT, topic: 'goal:demo', opener: 'izzo', opened_at: T0 });
    expect(t.huddle.closed).toEqual({ at: T0 + 400_000, by: 'izzo', anchor_ref: 'none' });
  });

  it('lists the opener, the named seats and the steered seat, each with how it was summoned', () => {
    const seats = build()!.seats.map((s) => [s.seat, s.summoned, s.summoned_by]);
    expect(seats).toEqual([
      ['izzo', 'opener', ROOT],
      ['miley', 'named', ROOT],
      ['ryder', 'named', ROOT],
      ['lazara', 'steered', STEER],
    ]);
  });

  it("joins a seat's wake by the act it answered, not by seat alone", () => {
    const by = Object.fromEntries(build()!.seats.map((s) => [s.seat, s]));
    expect(by['miley']!.wake).toEqual({
      lease_id: 'L1',
      leased_at: T0 + 35_000,
      spawned_at: T0 + 40_000,
      session: 'resumed',
      outcome: 'woke',
      duration_ms: 27_485,
      cost_usd: 0.56,
    });
    expect(by['lazara']!.wake).toMatchObject({ lease_id: 'L2', outcome: 'leased', session: null });
    expect(by['ryder']!.wake).toBeNull();
  });

  it('measures time-to-turn from when the seat was summoned', () => {
    const by = Object.fromEntries(build()!.seats.map((s) => [s.seat, s]));
    expect(by['miley']).toMatchObject({
      first_turn_at: T0 + 71_000,
      first_turn_act_id: 'T1',
      time_to_turn_ms: 71_000,
    });
    expect(by['ryder']).toMatchObject({
      first_turn_at: null,
      first_turn_act_id: null,
      time_to_turn_ms: null,
    });
    expect(by['miley']!.harness).toBe('claude-code');
    expect(by['lazara']!.harness).toBe('codex');
  });

  it('merges acts, wakes, tool steps and failed hooks into one ts-sorted timeline', () => {
    const ev = build()!.events;
    expect(ev.map((e) => e.ts)).toEqual([...ev.map((e) => e.ts)].sort((a, b) => a - b));
    const kinds = ev.map((e) => `${e.seat}:${e.kind}:${e.tool_name ?? e.label}`);
    expect(kinds).toContain('izzo:act:message: REHEARSAL 3: say which Replay lane you would take');
    expect(kinds).toContain('izzo:act:steer → lazara: you are in the huddle');
    expect(kinds).toContain('miley:tool:Bash');
    expect(kinds).toContain('ryder:tool:Grep');
    expect(ev.filter((e) => e.kind === 'hook')).toEqual([
      {
        ts: T0 + 62_000,
        seat: 'lazara',
        kind: 'hook',
        label: 'hook timeout',
        outcome: 'timeout',
        duration_ms: 10_000,
      },
    ]);
    expect(ev.some((e) => e.label.startsWith('woke'))).toBe(true);
    expect(ev.some((e) => e.label === 'settled · 27.5s · $0.56')).toBe(true);
  });

  it('names every wake and session step with a stable phase', () => {
    const phases = build()!
      .events.filter((e) => e.kind === 'wake' || e.kind === 'session')
      .map((e) => `${e.seat}:${e.phase}`);
    expect(phases).toEqual([
      'miley:leased',
      'lazara:leased',
      'miley:captured',
      'miley:woke',
      'miley:settled',
    ]);
  });

  it('shows a tool call once: the completed row, not also its PreToolUse', () => {
    const bash = build()!.events.filter((e) => e.tool_name === 'Bash');
    expect(bash).toEqual([
      {
        ts: T0 + 61_000,
        seat: 'miley',
        kind: 'tool',
        label: 'Bash',
        tool_name: 'Bash',
        outcome: 'ok',
        duration_ms: 1_000,
      },
    ]);
  });

  it('drops harness chatter (reasoning, text) and anything outside the window, and other threads', () => {
    const t = build()!;
    expect(t.events.some((e) => e.ts > T0 + 400_000)).toBe(false);
    expect(t.events.some((e) => e.act_id === 'X1')).toBe(false);
    expect(t.events.some((e) => e.label === 'reasoning')).toBe(false);
  });

  it('cuts at HUDDLE_TRACE_MAX_EVENTS and says so', () => {
    const flood: HuddleTraceRow[] = Array.from({ length: 2_100 }, (_, i) => ({
      ts: T0 + 100 + i,
      seat: 'miley',
      harness: 'claude-code',
      kind: 'PostToolUse',
      tool_name: 'Read',
      tool_use_id: `f${i}`,
      outcome: 'ok',
      duration_ms: 1,
    }));
    const t = assembleHuddleTrace({
      thread: [root],
      audit: [],
      spawnedAt: new Map(),
      trace: flood,
      now: T0 + 10_000,
    })!;
    expect(t.events).toHaveLength(2_000);
    expect(t.truncated).toBe(true);
  });
});
