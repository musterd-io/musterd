import { describe, expect, it } from 'vitest';
import { prWatchRepos, readPrState, rollupChecks } from './prState.js';

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
    expect(await readPrState('feat/x', 'musterd-io/musterd', run)).toEqual({
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
    expect(await readPrState('b', 'musterd-io/musterd', fail({ code: 'ENOENT' }))).toEqual({
      unknown: 'no_gh',
    });
    expect(
      await readPrState(
        'b',
        'musterd-io/musterd',
        fail({ stderr: 'no pull requests found for branch "b"' }),
      ),
    ).toEqual({
      unknown: 'no_pr',
    });
    expect(
      await readPrState(
        'b',
        'musterd-io/musterd',
        fail({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' }),
      ),
    ).toEqual({
      unknown: 'no_gh',
    });
    expect(
      await readPrState('b', 'musterd-io/musterd', fail({ message: 'Command failed: timed out' })),
    ).toEqual({
      unknown: 'gh_error',
    });
    expect(await readPrState('b', 'musterd-io/musterd', async () => 'not json')).toEqual({
      unknown: 'gh_error',
    });
  });

  it('never hands gh a ref it could read as a flag, and fences the ref with --', async () => {
    const seen: string[][] = [];
    const run = async (args: string[]) => {
      seen.push(args);
      return JSON.stringify({ number: 1, state: 'OPEN', statusCheckRollup: [] });
    };
    for (const bad of ['--repo=evil/x', '-R', 'a..b', 'a b', '']) {
      expect(await readPrState(bad, 'musterd-io/musterd', run)).toEqual({ unknown: 'gh_error' });
    }
    expect(seen).toEqual([]);
    await readPrState('feat/quick-actions', 'musterd-io/musterd', run);
    expect(seen[0]).toEqual([
      'pr',
      'view',
      '--repo',
      'musterd-io/musterd',
      '--json',
      'number,state,statusCheckRollup,isCrossRepository',
      '--',
      'feat/quick-actions',
    ]);
  });

  it('reads nothing for a team with no mapped repo, and never trusts a fork PR', async () => {
    let called = false;
    expect(
      await readPrState('feat/x', undefined, async () => {
        called = true;
        return '{}';
      }),
    ).toEqual({ unknown: 'no_repo' });
    expect(called).toBe(false);
    const fork = async () =>
      JSON.stringify({
        number: 9,
        state: 'MERGED',
        isCrossRepository: true,
        statusCheckRollup: [],
      });
    expect(await readPrState('feat/x', 'musterd-io/musterd', fork)).toEqual({ unknown: 'no_pr' });
  });

  it('prWatchRepos maps teams to repos and ignores anything malformed', () => {
    expect([
      ...prWatchRepos({
        MUSTERD_PR_WATCH_REPOS: 'revive=musterd-io/musterd, bad=x, Other=a/b, ok=a/b;rm',
      }).entries(),
    ]).toEqual([['revive', 'musterd-io/musterd']]);
    expect(prWatchRepos({}).size).toBe(0);
  });
});
