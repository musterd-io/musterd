import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/research-radar.yml', 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function script(name: string): string {
  return stepBlock(name)
    .split('        run: |\n')[1]!
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
}

function stepBlock(name: string): string {
  return workflow.split(`      - name: ${name}\n`)[1]!.split('\n      - ')[0]!;
}

function workflowFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? workflowFiles(path) : path.endsWith('.yml') ? [path] : [];
  });
}

function run(
  name: string,
  env: Record<string, string>,
  expectedStatus = 0,
): { output: string; summary: string; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'radar-workflow-'));
  dirs.push(dir);
  const output = join(dir, 'output');
  const summary = join(dir, 'summary');
  const calls = join(dir, 'calls');
  const report = join(dir, 'report.json');
  writeFileSync(
    report,
    JSON.stringify({
      candidates_fetched: 1,
      already_seen: 0,
      new_count: 1,
      printed: 1,
      truncated: false,
      readFailures: [],
      triage: { warnings: ['tier-1 failed: provider_or_response_error'] },
    }),
  );
  mkdirSync(join(dir, 'docs/research/radar'), { recursive: true });
  writeFileSync(
    join(dir, 'docs/research/radar/seen.json'),
    JSON.stringify({
      arxiv: [],
      hf: [],
      exn: [],
      pending: [
        { canonicalId: 'retry', failure: 'triage_incomplete', url: 'https://example.org/paper' },
      ],
    }),
  );
  writeFileSync(join(dir, 'docs/research/radar/2026-W42.md'), 'digest');
  for (const path of [output, summary, calls]) writeFileSync(path, '');
  const result = spawnSync(
    'bash',
    [
      '-e',
      '-o',
      'pipefail',
      '-c',
      String.raw`
    gh() { if [ "$2" = list ]; then echo 123; else echo "{\"state\":\"$TEST_STATE\",\"isDraft\":$TEST_DRAFT,\"reviews\":$TEST_REVIEWS}"; fi; }
    git() { echo "$*" >> "$TEST_CALLS"; }
    pnpm() { cat "$TEST_REPORT"; return "$TEST_SWEEP_EXIT"; }
    ${script(name)}
  `,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        TEST_CALLS: calls,
        TEST_STATE: 'OPEN',
        TEST_DRAFT: 'true',
        TEST_REVIEWS: '[]',
        EXISTING_PR: '123',
        TEST_REPORT: report,
        TEST_SWEEP_EXIT: '0',
        RUNNER_TEMP: dir,
        WEEK: '2026-W42',
        ...env,
      },
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(expectedStatus);
  return {
    output: readFileSync(output, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
    calls: readFileSync(calls, 'utf8'),
  };
}

describe('weekly radar workflow', () => {
  it('keeps a completed retry ledger publishable after recoverable model failure', () => {
    const result = run('Read full sources and triage', { TEST_SWEEP_EXIT: '2' });
    expect(result.summary).toContain(
      'Deferred retry: triage_incomplete — https://example.org/paper',
    );
    expect(result.summary).toContain('tier-1 failed: provider_or_response_error');
  });

  it('stops before publication after an artifact-write failure', () => {
    const result = run('Read full sources and triage', { TEST_SWEEP_EXIT: '1' }, 1);
    expect(result.summary).toBe('');
    expect(result.calls).toBe('');
  });
  it('loads the unreviewed draft before source processing', () => {
    const result = run('Select weekly draft PR', {});
    expect(result.calls).toContain('checkout -B automation/research-radar-');
    expect(workflow.indexOf('git checkout -B')).toBeLessThan(
      workflow.indexOf('pnpm --silent radar:sweep'),
    );
    expect(workflow).toContain('--emit --resume-draft');
  });

  it.each([{ TEST_REVIEWS: '[{}]' }, { TEST_STATE: 'CLOSED' }, { TEST_DRAFT: 'false' }])(
    'does not publish when a draft changes during processing: %j',
    (env) => {
      const result = run('Create or update the unreviewed weekly draft', env);
      expect(result.calls).toBe('');
      expect(result.summary).toContain('no updates published');
    },
  );

  it('names missing secrets before checkout without exposing their values', () => {
    const result = run('Check required secrets', {
      HAS_ANTHROPIC: 'true',
      HAS_STEWARD: 'true',
      HAS_EXA: 'false',
      HAS_EXPLORING: 'false',
    });
    expect(result.output).toContain('ready=false');
    expect(result.summary).toContain('EXA_API_KEY EXPLORING_API_KEY');
    expect(result.calls).toBe('');
  });

  it('has valid shell syntax in every multiline command', () => {
    for (const name of [
      'Check required secrets',
      'Select weekly draft PR',
      'Read full sources and triage',
      'Create or update the unreviewed weekly draft',
    ]) {
      const result = spawnSync('bash', ['-n'], { input: script(name), encoding: 'utf8' });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });

  it('pins every third-party GitHub Action to a full commit SHA and version comment', () => {
    const paths = [...workflowFiles('.github/workflows'), ...workflowFiles('.github/actions')];
    const unpinned = paths.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.includes('uses:'))
        .filter((line) => !line.includes('uses: ./'))
        .filter((line) => !/uses:\s+[^\s]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$/.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(unpinned).toEqual([]);
  });

  it('keeps STEWARD_TOKEN out of the radar checkout and read-only PR lookup', () => {
    const start = workflow.indexOf('      - uses: actions/checkout');
    const end = workflow.indexOf('\n      - name:', start + 1);
    const checkoutStep = workflow.slice(start, end);
    const lookup = stepBlock('Select weekly draft PR');
    const publish = stepBlock('Create or update the unreviewed weekly draft');

    expect(checkoutStep).toContain('persist-credentials: false');
    expect(checkoutStep).toContain('fetch-depth: 0');
    expect(checkoutStep).not.toContain('secrets.STEWARD_TOKEN');
    expect(lookup).toContain('GH_TOKEN: ${{ github.token }}');
    expect(lookup).not.toContain('secrets.STEWARD_TOKEN');
    expect(publish).toContain('GH_TOKEN: ${{ secrets.STEWARD_TOKEN }}');
    expect(publish).toContain('git push');
    expect(publish).toContain('gh pr create');
  });
});
