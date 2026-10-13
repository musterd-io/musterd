import { describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import type { HarnessAdapter } from '../onboard/reconcile/fragments.js';
import { chooseHarness, planLaunch } from './plan.js';
import type { Seat } from './store.js';

const seat = (over: Partial<Seat> = {}): Seat => ({
  address: 'revive/agents/stanley',
  team: 'revive',
  project: 'agents',
  member: 'stanley',
  server: 'http://127.0.0.1:4849',
  path: '/w/stanley',
  kind: 'agent',
  harnesses: ['claude-code', 'musterd'],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});
const adapter = (id: string, bin: string | null, installHint?: string): HarnessAdapter =>
  ({
    id,
    interactive: {
      resolveBin: async () => bin,
      ...(installHint ? { installHint } : {}),
      fresh: () => ['--fresh'],
      resume: (sid: string | undefined) => (sid ? ['--resume', sid] : ['--continue']),
    },
  }) as unknown as HarnessAdapter;
const REGISTRY = [
  adapter('claude-code', '/bin/claude'),
  adapter('codex', null, 'npm install -g @openai/codex'),
  adapter('grok', null),
  { id: 'musterd', interactive: null } as unknown as HarnessAdapter,
];
const base = {
  mode: 'fresh' as const,
  harness: null,
  session: null,
  recent: null,
  registry: REGISTRY,
  env: {},
};

describe('chooseHarness', () => {
  it('asked for > recent (if still desired) > first desired > last session > claude-code', () => {
    expect(chooseHarness(seat(), 'codex', null)).toBe('codex');
    expect(chooseHarness(seat({ harnesses: ['codex', 'claude-code'] }), null, 'claude-code')).toBe(
      'claude-code',
    );
    expect(chooseHarness(seat({ harnesses: ['codex'] }), null, 'grok')).toBe('codex');
    expect(chooseHarness(seat({ harnesses: ['musterd'] }), null, null)).toBe('claude-code');
    expect(
      chooseHarness(
        seat({ harnesses: [], last_session: { harness: 'grok', started_at: 1, ended_at: null } }),
        null,
        null,
      ),
    ).toBe('grok');
  });
});

describe('planLaunch (ADR 491)', () => {
  it('a fresh agent launch runs the resolved binary in the Workspace', async () => {
    expect(await planLaunch({ ...base, seat: seat() })).toEqual({
      bin: '/bin/claude',
      args: ['--fresh'],
      cwd: '/w/stanley',
      harness: 'claude-code',
    });
  });

  it('resume uses the recorded id only when its harness matches', async () => {
    const session = { harness: 'claude-code', id: 'S9' };
    expect((await planLaunch({ ...base, seat: seat(), mode: 'resume', session })).args).toEqual([
      '--resume',
      'S9',
    ]);
    const other = { harness: 'codex', id: 'C1' };
    expect(
      (await planLaunch({ ...base, seat: seat(), mode: 'resume', session: other })).args,
    ).toEqual(['--continue']);
  });

  it('a missing binary names the install hint (when the adapter has one) and the way out', async () => {
    const hinted = planLaunch({ ...base, seat: seat(), harness: 'codex' });
    await expect(hinted).rejects.toThrow(/install: npm install -g @openai\/codex/);
    await expect(hinted).rejects.toThrow(/musterd harness configure/);
    const bare = planLaunch({ ...base, seat: seat(), harness: 'grok' });
    await expect(bare).rejects.toThrow(/musterd harness configure/);
    await expect(bare).rejects.not.toThrow(/install:/);
  });

  it('a human seat gets a login shell', async () => {
    expect(
      await planLaunch({ ...base, seat: seat({ kind: 'human' }), env: { SHELL: '/bin/fish' } }),
    ).toEqual({
      bin: '/bin/fish',
      args: ['-l'],
      cwd: '/w/stanley',
      harness: 'shell',
    });
  });

  it('refuses a missing binary, the native host, and an unknown id — with the reason', async () => {
    await expect(planLaunch({ ...base, seat: seat(), harness: 'codex' })).rejects.toThrow(
      /codex is not installed/,
    );
    await expect(planLaunch({ ...base, seat: seat(), harness: 'musterd' })).rejects.toThrow(
      /musterd host/,
    );
    const unknown = planLaunch({ ...base, seat: seat(), harness: 'nope' });
    await expect(unknown).rejects.toBeInstanceOf(CliError);
    await expect(unknown).rejects.toThrow(/unknown harness "nope"/);
  });
});
