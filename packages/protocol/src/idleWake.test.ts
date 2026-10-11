import { describe, expect, it } from 'vitest';
import { HeartbeatFrame } from './frames.js';
import { IdleWakeReportSchema, IdleWakeStateSchema, InterruptSeamSchema } from './idleWake.js';
import { ResidencyPolicySchema } from './residency.js';

describe('idle-wake shapes (ADR 558)', () => {
  it('idle_wake defaults on', () => {
    expect(ResidencyPolicySchema.parse({}).idle_wake).toBe(true);
  });
  it('seam is boundary|idle', () => {
    expect(InterruptSeamSchema.safeParse('idle').success).toBe(true);
    expect(InterruptSeamSchema.safeParse('claude-code').success).toBe(false);
  });
  it('heartbeat carries hearing optionally', () => {
    expect(
      HeartbeatFrame.parse({ type: 'heartbeat', hearing: 'deaf', hearing_reason: 'no-socket' }),
    ).toMatchObject({ hearing: 'deaf', hearing_reason: 'no-socket' });
    expect(HeartbeatFrame.parse({ type: 'heartbeat' }).hearing).toBeUndefined();
  });
  it('a report is strict and never carries a body', () => {
    const ok = { act: '01ACT', outcome: 'injected', harness: 'claude-code' };
    expect(IdleWakeReportSchema.parse(ok)).toEqual(ok);
    expect(IdleWakeReportSchema.safeParse({ ...ok, line: 'x' }).success).toBe(false);
  });
  it('the local state file parses empty and keeps markers', () => {
    expect(IdleWakeStateSchema.parse({})).toEqual({});
    expect(
      IdleWakeStateSchema.parse({ session_id: 's', last_prompt_at: 1, last_stop_at: 2, switch: 'off' }),
    ).toMatchObject({ switch: 'off' });
  });
});
