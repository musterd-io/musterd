import { describe, expect, it } from 'vitest';
import { LiveSamplesSchema, MetricInputSchema, metricNudge } from './lanes.js';

/** ADR 701: live experiment points, the per-harness scope, and the nudge toward a chart. */
describe('metricNudge', () => {
  const dated = { reads_on: '2026-10-28', state: 'claimed' };

  it('nudges a dated read with no metric, in each surface’s own words', () => {
    expect(metricNudge(dated)).toContain('metric {name, unit, baseline, target');
    expect(metricNudge(dated, 'cli')).toContain('--metric "<name>"');
    expect(metricNudge(dated, 'cli')).toContain('musterd lane sample');
  });

  it('stays quiet with a metric, without a read day, once read, or once closed', () => {
    expect(metricNudge({ ...dated, metric: { name: 'm' } })).toBeNull();
    expect(metricNudge({ state: 'claimed' })).toBeNull();
    expect(metricNudge({ ...dated, read_verdict: { outcome: 'met' } })).toBeNull();
    expect(metricNudge({ ...dated, state: 'done' })).toBeNull();
    expect(metricNudge({ ...dated, state: 'abandoned' })).toBeNull();
  });
});

describe('live samples and harness scope', () => {
  it('a metric may name one harness; the live body is lane-tagged points', () => {
    const m = MetricInputSchema.parse({
      name: 'codex wake p50',
      unit: 'ms',
      baseline: null,
      target: 5000,
      direction: 'down',
      source: 'wake_latency_p50_ms',
      harness: 'codex',
    });
    expect(m.harness).toBe('codex');
    expect(
      LiveSamplesSchema.parse({
        samples: [{ lane: 'L1', day: '2026-10-21', value: 4, n: 2, as_of: 1 }],
      }).samples,
    ).toHaveLength(1);
    expect(() =>
      LiveSamplesSchema.parse({
        samples: [{ lane: 'L1', day: 'today', value: 4, n: 2, as_of: 1 }],
      }),
    ).toThrow();
  });
});
