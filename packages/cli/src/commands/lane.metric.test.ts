import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { metricFlags, readVerdictFlags } from './lane.js';

const flags = (argv: string[]) => parseArgs(['lane', 'update', 'L1', ...argv]).flags;

/** ADR 673: the CLI's metric and measured-verdict flags. */
describe('lane metric flags', () => {
  it('builds a metric, defaulting source to manual and baseline to null', () => {
    expect(
      metricFlags(
        flags(['--metric', 'hit rate', '--unit', '%', '--target', '60', '--direction', 'up']),
        false,
      ),
    ).toEqual({
      metric: {
        name: 'hit rate',
        unit: '%',
        target: 60,
        baseline: null,
        direction: 'up',
        source: 'manual',
      },
    });
  });

  it('clears with none on update only, and names what is missing', () => {
    expect(metricFlags(flags(['--metric', 'none']), true)).toEqual({ metric: null });
    expect(() => metricFlags(flags(['--metric', 'none']), false)).toThrow(/update/);
    expect(() => metricFlags(flags(['--metric', 'x', '--unit', '%']), false)).toThrow(/--target/);
    expect(() =>
      metricFlags(
        flags(['--metric', 'x', '--unit', '%', '--target', '1', '--direction', 'sideways']),
        false,
      ),
    ).toThrow(/up or down/);
    expect(metricFlags(flags([]), true)).toEqual({});
  });

  it('puts measured and evidence on the verdict, and wants --n with --measured', () => {
    expect(
      readVerdictFlags(
        flags([
          '--read-verdict',
          'met',
          '--read-note',
          'ranked picks won',
          '--measured',
          '61',
          '--n',
          '23',
          '--evidence',
          'ADR-536',
        ]),
      ),
    ).toEqual({
      read_verdict: {
        outcome: 'met',
        note: 'ranked picks won',
        measured: { value: 61, n: 23 },
        evidence: 'ADR-536',
      },
    });
    expect(() =>
      readVerdictFlags(flags(['--read-verdict', 'met', '--read-note', 'x', '--measured', '61'])),
    ).toThrow(/--n/);
  });
});
