import { describe, expect, it } from 'vitest';
import { LAUNCHABLE_HARNESSES } from '../../launcher/labels.js';
import { musterdCoreAdapter } from './musterd.js';
import { harnessAdapters } from './index.js';

/** The argv each harness takes, checked against its own `--help` on 2026-10-01 (spec §4.4). */
const EXPECTED: [string, string[], string[], string[]][] = [
  ['claude-code', [], ['--resume', 'S1'], ['--continue']],
  ['cursor', [], ['--resume', 'S1'], ['--continue']],
  ['codex', [], ['resume', 'S1'], ['resume', '--last']],
  ['opencode', [], ['--session', 'S1'], ['--continue']],
  ['grok', [], ['--resume', 'S1'], ['--continue']],
];

describe('interactive launch entries (ADR 491 Decision 5)', () => {
  const byId = new Map(harnessAdapters().map((a) => [a.id, a]));

  it.each(EXPECTED)('%s', (id, fresh, resumeWithId, resumeLatest) => {
    const entry = byId.get(id)?.interactive;
    expect(entry).toBeTruthy();
    expect(entry!.fresh()).toEqual(fresh);
    expect(entry!.resume('S1')).toEqual(resumeWithId);
    expect(entry!.resume(undefined)).toEqual(resumeLatest);
  });

  it('the native host and the musterd-core producer have no terminal entry', () => {
    expect(byId.get('musterd')?.interactive).toBeNull();
    expect(musterdCoreAdapter.interactive).toBeNull();
  });

  it('LAUNCHABLE_HARNESSES is exactly the registry ids that have an entry, in registry order', () => {
    const withEntry = harnessAdapters()
      .filter((a) => a.interactive)
      .map((a) => a.id);
    expect([...LAUNCHABLE_HARNESSES]).toEqual(withEntry);
  });
});
