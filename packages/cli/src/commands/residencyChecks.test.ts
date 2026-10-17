import type { Binding } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  ENROLLMENT_CHECKS,
  HARNESS_LOGIN_PROBES,
  enrollmentChecks,
  enrollmentRefusal,
  type EnrollmentChecksDeps,
} from './residencyChecks.js';

const bindingFor = (seat: string, credential = true): Binding =>
  ({
    version: 2,
    server: 'http://127.0.0.1:4849',
    team: 'revive',
    claim: { mode: 'seat', name: seat },
    ...(credential ? { agent_key: 'mskey_x' } : {}),
  }) as unknown as Binding;

function deps(over: Partial<EnrollmentChecksDeps> = {}): EnrollmentChecksDeps {
  return {
    resolveBin: async (h) => (h === 'claude-code' ? '/usr/local/bin/claude' : null),
    exists: () => true,
    keychain: async () => null,
    env: {},
    home: '/home/nick',
    findBinding: () => bindingFor('scout'),
    ...over,
  };
}

const byName = (checks: Awaited<ReturnType<typeof enrollmentChecks>>) =>
  Object.fromEntries(checks.map((c) => [c.name, c]));

describe('enrollmentChecks (ADR 645 §4.2: four verified checks before the row is written)', () => {
  it('passes all four for a logged-in claude-code seat in its own workspace', async () => {
    const checks = await enrollmentChecks(
      { seat: 'scout', harness: 'claude-code', dir: '/ws/scout' },
      deps({ exists: (p) => p === '/ws/scout' || p.endsWith('.credentials.json') }),
    );
    expect(checks.map((c) => c.name)).toEqual([...ENROLLMENT_CHECKS]);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(enrollmentRefusal(checks, 'scout')).toBeNull();
  });

  it('refuses a missing harness binary, naming the fix', async () => {
    const r = byName(
      await enrollmentChecks(
        { seat: 'scout', harness: 'codex', dir: '/ws/scout' },
        deps({ resolveBin: async () => null }),
      ),
    );
    expect(r['harness']?.ok).toBe(false);
    expect(r['harness']?.detail).toMatch(/no codex binary/);
  });

  it('login: a credential file, a provider key in env, or the Keychain item each count; none refuses', async () => {
    const base = { seat: 'scout', harness: 'claude-code', dir: '/ws/scout' };
    const none = byName(await enrollmentChecks(base, deps({ exists: (p) => p === '/ws/scout' })));
    expect(none['model_credential']?.ok).toBe(false);
    expect(none['model_credential']?.detail).toMatch(/not logged in/);

    const viaFile = byName(
      await enrollmentChecks(
        base,
        deps({ exists: (p) => p === '/ws/scout' || p === '/home/nick/.claude/.credentials.json' }),
      ),
    );
    expect(viaFile['model_credential']?.ok).toBe(true);

    const viaEnv = byName(
      await enrollmentChecks(
        base,
        deps({ exists: (p) => p === '/ws/scout', env: { ANTHROPIC_API_KEY: 'sk-x' } }),
      ),
    );
    expect(viaEnv['model_credential']?.detail).toMatch(/ANTHROPIC_API_KEY in env/);

    const viaKeychain = byName(
      await enrollmentChecks(
        base,
        deps({ exists: (p) => p === '/ws/scout', keychain: async () => 'present' }),
      ),
    );
    expect(viaKeychain['model_credential']?.detail).toMatch(/Keychain/);
  });

  it('opencode honours XDG_DATA_HOME for its login file', () => {
    const files = HARNESS_LOGIN_PROBES['opencode']!.files('/home/n', { XDG_DATA_HOME: '/xdg' });
    expect(files).toEqual(['/xdg/opencode/auth.json']);
  });

  it('a harness with no known login artifact is reported as not checked, never refused', async () => {
    const r = byName(
      await enrollmentChecks(
        { seat: 'scout', harness: 'cursor-agent', dir: '/ws/scout' },
        deps({ resolveBin: async () => undefined }),
      ),
    );
    expect(r['harness']?.ok).toBe(true);
    expect(r['harness']?.detail).toMatch(/not checked/);
    expect(r['model_credential']?.ok).toBe(true);
    expect(r['model_credential']?.detail).toMatch(/not checked/);
  });

  it('the native engine needs the key (env or Keychain) and a declared model, no binary', async () => {
    const base = {
      seat: 'resident',
      harness: 'musterd',
      dir: '/ws/resident',
      keyEnv: 'ANTHROPIC_API_KEY',
    };
    const d = deps({ findBinding: () => bindingFor('resident') });
    const noKey = byName(await enrollmentChecks({ ...base, model: 'claude-haiku-5-5' }, d));
    expect(noKey['harness']?.ok).toBe(true);
    expect(noKey['model_credential']?.ok).toBe(false);
    expect(noKey['model_credential']?.detail).toMatch(/Keychain item musterd:ANTHROPIC_API_KEY/);

    const noModel = byName(await enrollmentChecks(base, { ...d, keychain: async () => 'present' }));
    expect(noModel['model_credential']?.ok).toBe(false);
    expect(noModel['model_credential']?.detail).toMatch(/no model declared/);

    const ok = byName(
      await enrollmentChecks(
        { ...base, model: 'claude-haiku-5-5' },
        { ...d, keychain: async () => 'present' },
      ),
    );
    expect(ok['model_credential']?.detail).toMatch(/in Keychain · model claude-haiku-5-5/);
  });

  it('refuses a missing workspace, and a folder bound to another seat or to no credential', async () => {
    const gone = byName(
      await enrollmentChecks(
        { seat: 'scout', harness: 'claude-code', dir: '/ws/scout' },
        deps({ exists: (p) => p.endsWith('.credentials.json') }),
      ),
    );
    expect(gone['workspace']?.ok).toBe(false);
    expect(gone['seat_credential']?.ok).toBe(false);

    const other = byName(
      await enrollmentChecks(
        { seat: 'scout', harness: 'claude-code', dir: '/ws/izzo' },
        deps({ findBinding: () => bindingFor('izzo') }),
      ),
    );
    expect(other['seat_credential']?.ok).toBe(false);
    expect(other['seat_credential']?.detail).toMatch(/bound to "izzo", not "scout"/);

    const noCred = byName(
      await enrollmentChecks(
        { seat: 'scout', harness: 'claude-code', dir: '/ws/scout' },
        deps({ findBinding: () => bindingFor('scout', false) }),
      ),
    );
    expect(noCred['seat_credential']?.ok).toBe(false);
    expect(noCred['seat_credential']?.detail).toMatch(/holds no credential/);

    const noBinding = byName(
      await enrollmentChecks(
        { seat: 'scout', harness: 'claude-code', dir: '/ws/scout' },
        deps({ findBinding: () => null }),
      ),
    );
    expect(noBinding['seat_credential']?.detail).toMatch(/binding.json is missing/);
  });

  it('the refusal names every failing check and says nothing was written', async () => {
    const checks = await enrollmentChecks(
      { seat: 'scout', harness: 'grok', dir: null },
      deps({ resolveBin: async () => null, exists: () => false }),
    );
    const text = enrollmentRefusal(checks, 'scout');
    expect(text).toMatch(/4 of 4 checks failed/);
    expect(text).toMatch(/nothing was written/);
    expect(text).toMatch(/✗ harness/);
    expect(text).toMatch(/✗ workspace/);
  });
});
