import type { FlowMetrics, GoalFlow, Report, WakeMetrics } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { fmtReport } from './insights.js';

function flow(over: Partial<FlowMetrics> = {}): FlowMetrics {
  return {
    throughput_7d: 0,
    cycle_time_ms: null,
    wip: 0,
    oldest_wip_age_ms: null,
    backlog: 0,
    ...over,
  };
}

const DAY = 24 * 60 * 60 * 1000;

function report(over: Partial<Report> = {}): Report {
  return {
    team: 'revive',
    generated_ts: 1_000_000,
    flow: flow(),
    waiting_on: [],
    goals: [],
    blocked: [],
    coordination: {
      exchange_ratio: 0.5,
      journal_ratio: 0.5,
      acts: 10,
      window_days: 7,
      flag: false,
    },
    open_directed: [],
    mast: {
      window_days: 7,
      time_to_unblock: { closed: 0, median_ms: null, p95_ms: null },
      ignored_help: [],
      stalled_threads: [],
      circular_handoffs: [],
      diversity: [],
    },
    steering: {
      window_days: 7,
      steers: 0,
      acked: 0,
      latency_median_ms: null,
      latency_p95_ms: null,
      superseded_acts: 0,
      stale_wakes: 0,
      stale_caught: 0,
    },
    ...over,
  };
}

describe('fmtReport — the backlog gauge (ADR 295)', () => {
  // The CLI and MCP report have no second fetch, so the `open` queue that the web board reads off
  // /lanes was simply invisible to them.
  it('names the queue on the flow line', () => {
    const out = fmtReport(report({ flow: flow({ wip: 4, backlog: 3 }) }), 'team');
    expect(out).toContain('WIP 4');
    expect(out).toContain('queued 3');
  });

  it('omits the queue against a pre-295 daemon that does not send it', () => {
    const legacy = flow({ wip: 4 });
    delete legacy.backlog;
    const out = fmtReport(report({ flow: legacy }), 'team');
    expect(out).toContain('WIP 4');
    expect(out).not.toContain('queued');
  });
});

describe('fmtReport — per-goal flow (ADR 295)', () => {
  const goalFlow: GoalFlow[] = [
    { goal_id: 'launch', flow: flow({ wip: 1, oldest_wip_age_ms: 11 * DAY, backlog: 2 }) },
    { goal_id: 'research', flow: flow({ wip: 2, oldest_wip_age_ms: 3 * DAY }) },
    { goal_id: null, flow: flow({ wip: 1, oldest_wip_age_ms: DAY }) },
  ];

  it('breaks flow down by goal at the team altitude', () => {
    const out = fmtReport(report({ goal_flow: goalFlow }), 'team');
    expect(out).toContain('per goal:');
    expect(out).toContain('launch');
    expect(out).toContain('research');
  });

  it('names the goal-less pool rather than printing a bare null', () => {
    const out = fmtReport(report({ goal_flow: goalFlow }), 'team');
    expect(out).toContain('(no goal)');
    expect(out).not.toContain('null');
  });

  it('keeps the engine ordering — the dragging goal reads first', () => {
    const out = fmtReport(report({ goal_flow: goalFlow }), 'team');
    expect(out.indexOf('launch')).toBeLessThan(out.indexOf('research'));
  });

  it('says nothing at all when no lane names a goal', () => {
    const out = fmtReport(report({ goal_flow: [] }), 'team');
    expect(out).not.toContain('per goal:');
  });
});

function wake(over: Partial<WakeMetrics> = {}): WakeMetrics {
  return {
    window_days: 7,
    wakes: 0,
    resumed: 0,
    failed: 0,
    deferred: 0,
    exhausted: 0,
    answered: 0,
    answer_rate: null,
    latency_median_ms: null,
    latency_p95_ms: null,
    cost_usd_total: null,
    cost_usd_per_wake: null,
    cost_reported: 0,
    delivery: { fresh: 0, resumed: 0, fresh_fallback: 0 },
    exact_match: { bound: 0, missing: 0, mismatched: 0, stale: 0 },
    delivery_measured: 0,
    exact_match_measured: 0,
    by_seat: [],
    ...over,
  };
}

describe('fmtReport — spend cap (ADR 602)', () => {
  it('says nothing about a cap that was never set', () => {
    const quiet = fmtReport(report({ wake: wake() }), 'team');
    expect(quiet).not.toContain('cap $');
    const active = fmtReport(
      report({
        wake: wake({ wakes: 1, cost_usd_total: 4, cost_usd_per_wake: 4, cost_reported: 1 }),
      }),
      'team',
    );
    expect(active).toContain('cost $4.00');
    expect(active).not.toContain('cap $');
  });

  it('prints the cap beside priced spend, and a quiet line when nothing was priced', () => {
    const under = fmtReport(
      report({
        wake: wake({
          wakes: 1,
          cost_usd_total: 4,
          cost_usd_per_wake: 4,
          cost_reported: 1,
          spend_cap_usd: 10,
          spend_over_cap: false,
        }),
      }),
      'team',
    );
    expect(under).toContain('cap $10.00 under · measured wake cost, not payments');
    expect(under).not.toContain('OVER');

    const over = fmtReport(
      report({
        wake: wake({
          wakes: 1,
          cost_usd_total: 12,
          cost_usd_per_wake: 12,
          cost_reported: 1,
          spend_cap_usd: 10,
          spend_over_cap: true,
        }),
      }),
      'team',
    );
    expect(over).toContain(
      'cap $10.00 OVER · agent wakes held · window 7d · measured wake cost, not payments',
    );

    const quiet = fmtReport(
      report({ wake: wake({ spend_cap_usd: 10, spend_over_cap: false }) }),
      'team',
    );
    expect(quiet).toContain('cap $10.00 no priced spend · measured wake cost, not payments');
    expect(quiet).not.toContain('OVER');
  });
});

describe('fmtReport — delivery says past cursor (ADR 652)', () => {
  it('names the cursor row instead of printing seen', () => {
    const out = fmtReport(
      report({
        open_directed: [
          {
            id: 'h1',
            act: 'request_help',
            from: 'ada',
            to_kind: 'member',
            thread: null,
            ts: 1,
            age_ms: 5_000,
            urgent: false,
            recipients: [
              {
                seat: 'nick',
                seat_id: 'nick',
                state: 'seen',
                seen_by: 1_000,
                cursor_on: 'h1',
                answered: null,
                interrupt_raises: 0,
                ccd_nudges: 0,
                ccd_nudges_verbatim: 0,
              },
            ],
          },
        ],
      }),
      'team',
    );
    expect(out).toContain('nick: past cursor on h1');
    expect(out).not.toContain('nick: seen');
  });
});

describe('fmtReport — spend approval (ADR 635)', () => {
  it('says nothing about a threshold that was never set', () => {
    const quiet = fmtReport(report({ wake: wake() }), 'team');
    expect(quiet).not.toContain('approval $');
    const active = fmtReport(
      report({
        wake: wake({ wakes: 1, cost_usd_total: 4, cost_usd_per_wake: 4, cost_reported: 1 }),
      }),
      'team',
    );
    expect(active).toContain('cost $4.00');
    expect(active).not.toContain('approval $');
  });

  it('prints the per-wake threshold on an active wake and on a quiet window', () => {
    const active = fmtReport(
      report({
        wake: wake({
          wakes: 1,
          cost_usd_total: 4,
          cost_usd_per_wake: 4,
          cost_reported: 1,
          spend_approval_usd: 10,
        }),
      }),
      'team',
    );
    expect(active).toContain('approval $10.00 per wake · gateway running cost · display only');
    expect(active).not.toContain('OVER');

    const quiet = fmtReport(report({ wake: wake({ spend_approval_usd: 10 }) }), 'team');
    expect(quiet).toContain('approval $10.00 per wake · gateway running cost · display only');
    expect(quiet).toContain('wake:');
    expect(quiet).not.toContain('cap $');
  });
});

describe('fmtReport — unpriced wake cap (ADR 639)', () => {
  it('says nothing about a count cap that was never set', () => {
    const quiet = fmtReport(report({ wake: wake() }), 'team');
    expect(quiet).not.toContain('unpriced wakes');
    const active = fmtReport(
      report({
        wake: wake({ wakes: 1, cost_usd_total: 4, cost_usd_per_wake: 4, cost_reported: 1 }),
      }),
      'team',
    );
    expect(active).toContain('cost $4.00');
    expect(active).not.toContain('unpriced wakes');
  });

  it('prints the count on an active wake and on a quiet window', () => {
    const under = fmtReport(
      report({
        wake: wake({
          wakes: 1,
          cost_usd_total: 4,
          cost_usd_per_wake: 4,
          cost_reported: 1,
          unpriced_wake_cap: 5,
          unpriced_wake_count: 1,
          unpriced_over_cap: false,
        }),
      }),
      'team',
    );
    expect(under).toContain('unpriced wakes 1 · cap 5 under');
    expect(under).not.toContain('display only');
    expect(under).not.toContain('OVER');
    expect(under).not.toContain('agent wakes held');

    const over = fmtReport(
      report({
        wake: wake({
          unpriced_wake_cap: 0,
          unpriced_wake_count: 0,
          unpriced_over_cap: true,
        }),
      }),
      'team',
    );
    expect(over).toContain('unpriced wakes 0 · cap 0 OVER · agent wakes held · window 7d');
    expect(over).toContain('wake:');
    expect(over).not.toContain('display only');
  });

  it('names both caps in one notice when both are over', () => {
    const text = fmtReport(
      report({
        wake: wake({
          wakes: 2,
          cost_usd_total: 12,
          cost_usd_per_wake: 6,
          cost_reported: 2,
          spend_cap_usd: 10,
          spend_over_cap: true,
          unpriced_wake_cap: 2,
          unpriced_wake_count: 3,
          unpriced_over_cap: true,
        }),
      }),
      'team',
    );
    const held = text.split('\n').filter((line) => line.includes('agent wakes held'));
    expect(held).toHaveLength(1);
    expect(text).toContain(
      'agent wakes held · window 7d · cap $10.00 total $12.00 · unpriced wakes 3 cap 2',
    );
    expect(text).toContain('cap $10.00 OVER');
    expect(text).toContain('unpriced wakes 3 · cap 2 OVER');
    expect(text).not.toContain('display only');
  });
});
