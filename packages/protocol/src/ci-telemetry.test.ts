import { describe, expect, it } from 'vitest';
import { CiRunSampleSchema } from './ci-telemetry.js';

const good = {
  run_id: '38793954877',
  head_sha: 'bf65edeec25cb169535f1f2f93a8f21c76a0e1d6',
  branch: 'main',
  event: 'push',
  attempt: 1,
  conclusion: 'success',
  created_at: 1792092000000,
  duration_ms: 120000,
  jobs: [{ name: 'coverage (1)', conclusion: 'success', duration_ms: 90000 }],
};

describe('CiRunSampleSchema (ADR 610)', () => {
  it('accepts a run as the forge prints it', () => {
    expect(CiRunSampleSchema.safeParse(good).success).toBe(true);
  });
  it('refuses what a terminal could interpret or a ledger could not key on', () => {
    const bad = [
      { ...good, run_id: 'abc' },
      { ...good, head_sha: 'ZZZ' },
      { ...good, event: 'pull request' },
      { ...good, conclusion: 'ok\u001b[31m' },
      { ...good, branch: 'feat/\u001b[2Jx' },
      { ...good, jobs: [{ name: 'docs\u0007', conclusion: 'success', duration_ms: 1 }] },
    ];
    for (const b of bad)
      expect(CiRunSampleSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });
});
