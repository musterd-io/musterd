import { PULSE_WINDOW_MS, type SeatPulseFrame, type TraceEvent } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { PULSE_MIN_GAP_MS, SeatPulses } from './seatPulses.js';

/** A fake clock and a captured scheduler: timers fire only when the test says so. */
function rig(start = 1_000_000) {
  let now = start;
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const pushed: { teamId: string; frame: SeatPulseFrame }[] = [];
  const pulses = new SeatPulses({
    now: () => now,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    push: (teamId, frame) => pushed.push({ teamId, frame }),
  });
  const armed = () => timers.filter((t) => !t.cancelled);
  const fire = () => {
    const live = armed();
    for (const t of live) t.cancelled = true;
    for (const t of live) t.fn();
  };
  return {
    pulses,
    timers,
    pushed,
    armed,
    fire,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

function call(over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    harness: 'claude-code',
    session_digest: 'abcdef0123456789',
    ts: 1_000_000,
    kind: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'a',
    ...over,
  } as TraceEvent;
}

describe('SeatPulses (ADR 660)', () => {
  it('one call arms exactly one timer at the gap and pushes nothing yet', () => {
    const r = rig();
    r.pulses.feed('t1', 'miley', [call()]);
    expect(r.armed()).toHaveLength(1);
    expect(r.armed()[0]!.ms).toBe(PULSE_MIN_GAP_MS);
    expect(r.pushed).toEqual([]);
  });

  it('the fire pushes one frame of counts and kinds only', () => {
    const r = rig();
    r.pulses.feed('t1', 'miley', [call({ ts: r.now() })]);
    r.advance(PULSE_MIN_GAP_MS);
    r.fire();
    expect(r.pushed).toEqual([
      {
        teamId: 't1',
        frame: {
          type: 'seat_pulse',
          member: 'miley',
          ts: r.now(),
          intensity: 1,
          kind: 'run',
          last_ts: r.now() - PULSE_MIN_GAP_MS,
        },
      },
    ]);
  });

  it('ten calls in two seconds, then silence: one pulse of 10 and no second timer', () => {
    const r = rig();
    for (let i = 0; i < 10; i += 1) {
      r.pulses.feed('t1', 'miley', [call({ tool_use_id: `c${i}`, ts: r.now() })]);
      r.advance(200);
    }
    expect(r.armed()).toHaveLength(1);
    r.advance(PULSE_MIN_GAP_MS - 2_000);
    r.fire();
    expect(r.pushed).toHaveLength(1);
    expect(r.pushed[0]!.frame.intensity).toBe(10);
    expect(r.armed()).toHaveLength(0);
  });

  it('a call after the fire re-arms one timer', () => {
    const r = rig();
    r.pulses.feed('t1', 'miley', [call({ ts: r.now() })]);
    r.fire();
    r.pulses.feed('t1', 'miley', [call({ tool_use_id: 'b', ts: r.now() })]);
    expect(r.armed()).toHaveLength(1);
  });

  it('ignores everything that is not a completed tool call with a tool_use_id', () => {
    const r = rig();
    r.pulses.feed('t1', 'miley', [
      call({ kind: 'HookOutcome' }),
      call({ kind: 'usage' as TraceEvent['kind'] }),
      call({ kind: 'SessionStart' }),
      call({ tool_use_id: undefined }),
    ]);
    expect(r.armed()).toHaveLength(0);
    expect(r.pulses.snapshot('t1')).toEqual([]);
  });

  it('PostToolUseFailure counts', () => {
    const r = rig();
    r.pulses.feed('t1', 'miley', [call({ kind: 'PostToolUseFailure', ts: r.now() })]);
    expect(r.armed()).toHaveLength(1);
    expect(r.pulses.snapshot('t1')[0]!.intensity).toBe(1);
  });

  it('snapshot projects the current window and drops a seat once its window empties', () => {
    const r = rig();
    r.pulses.feed('t1', 'miley', [call({ tool_name: 'Edit', ts: r.now() })]);
    r.fire();
    expect(r.pulses.snapshot('t1')).toEqual([
      expect.objectContaining({ type: 'seat_pulse', member: 'miley', intensity: 1, kind: 'edit' }),
    ]);
    r.advance(PULSE_WINDOW_MS + 1);
    expect(r.pulses.snapshot('t1')).toEqual([]);
  });

  it('a fire with an emptied window pushes nothing (no intensity-0 frame)', () => {
    const r = rig();
    r.pulses.feed('t1', 'miley', [call({ ts: r.now() - PULSE_WINDOW_MS + 1 })]);
    r.advance(PULSE_MIN_GAP_MS);
    r.fire();
    expect(r.pushed).toEqual([]);
  });

  it('two teams with the same seat name are independent', () => {
    const r = rig();
    r.pulses.feed('t1', 'miley', [call({ ts: r.now() })]);
    r.pulses.feed('t2', 'miley', [
      call({ tool_use_id: 'x', ts: r.now() }),
      call({ tool_use_id: 'y', ts: r.now() }),
    ]);
    expect(r.armed()).toHaveLength(2);
    r.fire();
    const byTeam = Object.fromEntries(r.pushed.map((p) => [p.teamId, p.frame.intensity]));
    expect(byTeam).toEqual({ t1: 1, t2: 2 });
  });

  it('dispose cancels an armed timer', () => {
    const r = rig();
    r.pulses.feed('t1', 'miley', [call({ ts: r.now() })]);
    r.pulses.dispose();
    expect(r.armed()).toHaveLength(0);
    expect(r.timers[0]!.cancelled).toBe(true);
  });
});
