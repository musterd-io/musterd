import { describe, expect, it } from 'vitest';
import { render } from './wakeContext.js';

describe('team_wake_context render (ADR 430)', () => {
  it('shows the thread attributed, the ledger, the memory, and no follow-ups when everything fit', () => {
    const text = render({
      version: 2,
      wake: { kind: 'reply', act_id: 'a2' },
      objective: { action: 'reply' },
      state: {},
      context: {
        thread: {
          acts: [
            { id: 'a1', from: 'nick', act: 'message', ts: 1_000, body: 'first', truncated: false },
            {
              id: 'a2',
              from: 'nick',
              act: 'steer',
              ts: 2_000,
              body: 'do the thing',
              truncated: true,
            },
          ],
          omitted: 0,
        },
        open: [{ kind: 'ask', id: 'q1', from: 'izzo', title: 'review #12', age_ms: 90_000 }],
        memory: { body: 'carrying lane X', truncated: false },
      },
      budget: { limit_bytes: 12_288, used_bytes: 300 },
      fetch: [],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toContain('wake context: reply a2');
    expect(text).toContain('nick · message · a1: first');
    expect(text).toContain('nick · steer · a2: do the thing …');
    expect(text).toContain('open: ask q1 from izzo — review #12 (2m)');
    expect(text).toContain('memory:\ncarrying lane X');
    expect(text).not.toContain('explicit reads');
  });

  it("ADR 726: with no status naming the lane, says its state and the seat's last action", () => {
    const text = render({
      version: 2,
      wake: { kind: 'work_order', lane_id: 'L1' },
      objective: { action: 'continue_lane' },
      state: {},
      context: {
        open: [],
        lane: {
          detail: 'D',
          truncated: false,
          activity: { state: 'active', last_action_at: Date.now() - 20 * 60_000 },
        },
      },
      budget: { limit_bytes: 12_288, used_bytes: 100 },
      fetch: [],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toMatch(/lane state: active, your last action 20m ago/);
    expect(text).not.toContain('your last word on it');
  });

  it('names the follow-ups only for what did not fit', () => {
    const text = render({
      version: 2,
      wake: { kind: 'work_order', lane_id: 'L1' },
      objective: { action: 'continue_lane' },
      state: {},
      context: { open: [], lane: { detail: 'D', truncated: true } },
      budget: { limit_bytes: 12_288, used_bytes: 100 },
      fetch: ['lane_detail', 'open_items', 'git_artifact'],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toContain('lane: D …');
    expect(text).toContain(
      'explicit reads: lane_board, team_inbox_check (open items did not fit), git artifact on the declared branch',
    );
  });

  it('ADR 522: carries the checks under one heading, ⚠ for anything that changes the reading', () => {
    const text = render({
      version: 2,
      wake: { kind: 'reply', act_id: 'h1' },
      objective: { action: 'reply' },
      state: {},
      context: {
        open: [],
        memory: { body: 'carrying L1', truncated: false },
        checks: [
          {
            source: 'memory',
            kind: 'lane',
            ref: 'L1',
            verdict: 'ended',
            line: 'lane L1 ("x") is done — nothing in this note about it is still to do.',
          },
          {
            source: 'handoff',
            source_id: 'h1',
            kind: 'rule',
            ref: "don't merge",
            verdict: 'unsourced',
            line: '"don\'t merge" — no active Team hold says this, so the Team is not paused.',
          },
        ],
      },
      budget: { limit_bytes: 12_288, used_bytes: 400 },
      fetch: [],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toContain('checked against the Team now:');
    expect(text).toContain('  ⚠ lane L1 ("x") is done');
    expect(text).toContain('  ⚠ "don\'t merge" — no active Team hold says this');
  });

  it('v1 renders exactly as before', () => {
    const text = render({
      version: 1,
      wake: { kind: 'reply', act_id: 'a1' },
      objective: { action: 'reply' },
      state: {},
      fetch: ['inbox_thread', 'seat_memory'],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(text).toContain('explicit reads: team_inbox_check, team_memory_read');
    expect(text).not.toContain('thread (');
  });
});
