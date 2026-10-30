import { describe, expect, it } from 'vitest';
import { readPrState, rollupChecks } from './prState.js';

const fail = (o: { code?: string; stderr?: string; message?: string }) => () =>
  Promise.reject(Object.assign(new Error(o.message ?? 'gh failed'), o));

describe('readPrState (ADR 779 §4)', () => {
  it('reads a merged PR with green checks', async () => {
    const run = async () =>
      JSON.stringify({
        number: 3654,
        state: 'MERGED',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      });
    expect(await readPrState('feat/x', run)).toEqual({
      number: 3654,
      state: 'merged',
      checks: 'green',
    });
  });

  it('a failed check is red, a running one pending, none is none', () => {
    expect(rollupChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('red');
    expect(
      rollupChecks([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }]),
    ).toBe('pending');
    expect(rollupChecks([])).toBe('none');
  });

  it('says why it could not read, instead of failing silently', async () => {
    expect(await readPrState('b', fail({ code: 'ENOENT' }))).toEqual({ unknown: 'no_gh' });
    expect(
      await readPrState('b', fail({ stderr: 'no pull requests found for branch "b"' })),
    ).toEqual({
      unknown: 'no_pr',
    });
    expect(
      await readPrState(
        'b',
        fail({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' }),
      ),
    ).toEqual({
      unknown: 'no_gh',
    });
    expect(await readPrState('b', fail({ message: 'Command failed: timed out' }))).toEqual({
      unknown: 'gh_error',
    });
    expect(await readPrState('b', async () => 'not json')).toEqual({ unknown: 'gh_error' });
  });

  it('never hands gh a ref it could read as a flag, and fences the ref with --', async () => {
    const seen: string[][] = [];
    const run = async (args: string[]) => {
      seen.push(args);
      return JSON.stringify({ number: 1, state: 'OPEN', statusCheckRollup: [] });
    };
    for (const bad of ['--repo=evil/x', '-R', 'a..b', 'a b', '']) {
      expect(await readPrState(bad, run)).toEqual({ unknown: 'gh_error' });
    }
    expect(seen).toEqual([]);
    await readPrState('feat/quick-actions', run);
    expect(seen[0]).toEqual([
      'pr',
      'view',
      '--json',
      'number,state,statusCheckRollup',
      '--',
      'feat/quick-actions',
    ]);
  });
});
