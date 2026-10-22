import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ExperimentSpark from './ExperimentSpark';

const metric = { name: 'push-back rate', unit: '%', baseline: 18, target: 30, direction: 'up' as const };

describe('ExperimentSpark (lane 01M5GE8AX4)', () => {
  it('a series draws the line over a soft fill, the target rule, and lands on an end dot', () => {
    const html = renderToStaticMarkup(
      <ExperimentSpark
        metric={metric}
        samples={[
          { day: '2026-10-19', value: 22, n: 4 },
          { day: '2026-10-20', value: 27, n: 3 },
        ]}
        read={false}
      />,
    );
    expect(html).toContain('lc-xp__spark-area');
    expect(html).toContain('lc-xp__spark-line');
    expect(html).toContain('lc-xp__spark-target');
    expect(html).toContain('lc-xp__spark-dot');
    expect(html).not.toContain('day 1');
  });

  it('day one: the number with · day 1, a dotted trail, no line', () => {
    const html = renderToStaticMarkup(
      <ExperimentSpark metric={metric} samples={[{ day: '2026-10-21', value: 31, n: 3, live: true, asOf: 1 }]} read={false} />,
    );
    expect(html).toContain('lc-xp__spark-lead');
    expect(html).not.toContain('lc-xp__spark-line');
    expect(html).toContain('lc-xp__spark-now');
    expect(html).toContain('· day 1');
    expect(html).toContain(' now');
  });
});
