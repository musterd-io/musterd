import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import { CLOUD_ENV, resolveCloudConfig } from './mode.js';

// A sentinel password: no error message may ever contain it (hard rule 5).
const SECRET = 'hunter2-sentinel';
const FULL: Record<string, string> = {
  MUSTERD_MODE: 'cloud',
  MUSTERD_DATABASE_APP_URL: `postgres://app:${SECRET}@pool.example/musterd`,
  MUSTERD_DATABASE_OPERATOR_URL: `postgres://op:${SECRET}@pool.example/musterd`,
  MUSTERD_TRACE_DATABASE_APP_URL: `postgres://app:${SECRET}@pool.example/musterd_trace`,
  MUSTERD_TRACE_DATABASE_OPERATOR_URL: `postgresql://op:${SECRET}@pool.example/musterd_trace`,
  MUSTERD_CONSOLE_JWKS_URL: 'https://app.musterd.io/.well-known/jwks.json',
  MUSTERD_CONSOLE_AUDIENCE: 'https://team.musterd.dev',
  MUSTERD_CLOUD_HOST_SUFFIX: 'Musterd.Dev',
};

describe('resolveCloudConfig', () => {
  it('is null when MUSTERD_MODE is unset, empty, or self-hosted', () => {
    expect(resolveCloudConfig({})).toBeNull();
    expect(resolveCloudConfig({ MUSTERD_MODE: '' })).toBeNull();
    expect(resolveCloudConfig({ MUSTERD_MODE: 'self-hosted' })).toBeNull();
  });

  it('refuses an unknown mode, naming the variable', () => {
    expect(() => resolveCloudConfig({ MUSTERD_MODE: 'clod' })).toThrow(/MUSTERD_MODE/);
  });

  it('reads the full cloud block, normalising the host suffix', () => {
    const c = resolveCloudConfig(FULL);
    expect(c).toEqual({
      databaseAppUrl: FULL['MUSTERD_DATABASE_APP_URL'],
      databaseOperatorUrl: FULL['MUSTERD_DATABASE_OPERATOR_URL'],
      traceDatabaseAppUrl: FULL['MUSTERD_TRACE_DATABASE_APP_URL'],
      traceDatabaseOperatorUrl: FULL['MUSTERD_TRACE_DATABASE_OPERATOR_URL'],
      consoleJwksUrl: FULL['MUSTERD_CONSOLE_JWKS_URL'],
      consoleAudience: FULL['MUSTERD_CONSOLE_AUDIENCE'],
      hostSuffix: 'musterd.dev',
      teamBudgetPerMin: 600,
    });
  });

  it('reads an optional MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN, refusing a non-positive-integer by name', () => {
    expect(
      resolveCloudConfig({ ...FULL, MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN: '1200' })?.teamBudgetPerMin,
    ).toBe(1200);
    for (const bad of ['0', '-3', '2.5', 'many'])
      expect(() => resolveCloudConfig({ ...FULL, MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN: bad })).toThrow(
        /MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN must be a positive integer/,
      );
  });

  it('reads an optional MUSTERD_PG_POOL_SIZE, refusing a non-positive-integer by name', () => {
    expect(resolveCloudConfig(FULL)?.pgPoolSize).toBeUndefined();
    expect(resolveCloudConfig({ ...FULL, MUSTERD_PG_POOL_SIZE: '40' })?.pgPoolSize).toBe(40);
    for (const bad of ['0', '-3', '2.5', 'many'])
      expect(() => resolveCloudConfig({ ...FULL, MUSTERD_PG_POOL_SIZE: bad })).toThrow(
        /MUSTERD_PG_POOL_SIZE must be a positive integer/,
      );
  });

  it('accepts a leading dot on the host suffix', () => {
    expect(
      resolveCloudConfig({ ...FULL, MUSTERD_CLOUD_HOST_SUFFIX: '.musterd.dev' })?.hostSuffix,
    ).toBe('musterd.dev');
  });

  it.each(CLOUD_ENV.filter((k) => k !== 'MUSTERD_MODE'))(
    'refuses to start without %s, naming it',
    (name) => {
      const env = { ...FULL };
      delete env[name];
      expect(() => resolveCloudConfig(env)).toThrow(new RegExp(name));
    },
  );

  it('refuses a database URL that is not postgres, and never echoes its value', () => {
    const env = { ...FULL, MUSTERD_DATABASE_APP_URL: `mysql://app:${SECRET}@h/db` };
    let msg = '';
    try {
      resolveCloudConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/MUSTERD_DATABASE_APP_URL/);
    expect(msg).not.toContain(SECRET);
  });

  it('refuses a malformed database URL without echoing it', () => {
    const env = { ...FULL, MUSTERD_DATABASE_OPERATOR_URL: `not a url ${SECRET}` };
    expect(() => resolveCloudConfig(env)).toThrow(/MUSTERD_DATABASE_OPERATOR_URL/);
    try {
      resolveCloudConfig(env);
    } catch (e) {
      expect((e as Error).message).not.toContain(SECRET);
    }
  });

  it('requires https for the JWKS, except on loopback (the test issuer)', () => {
    expect(() =>
      resolveCloudConfig({ ...FULL, MUSTERD_CONSOLE_JWKS_URL: 'http://console.example/jwks' }),
    ).toThrow(/MUSTERD_CONSOLE_JWKS_URL/);
    expect(
      resolveCloudConfig({ ...FULL, MUSTERD_CONSOLE_JWKS_URL: 'http://127.0.0.1:9999/jwks' })
        ?.consoleJwksUrl,
    ).toBe('http://127.0.0.1:9999/jwks');
  });
});

describe('resolveConfig in cloud mode', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is self-hosted with no cloud block by default', () => {
    vi.stubEnv('MUSTERD_MODE', '');
    const c = resolveConfig();
    expect(c.mode).toBe('self-hosted');
    expect(c.cloud).toBeNull();
  });

  it('carries the cloud block, trusts the edge proxy, and names no SQLite file', () => {
    for (const [k, v] of Object.entries(FULL)) vi.stubEnv(k, v);
    const c = resolveConfig();
    expect(c.mode).toBe('cloud');
    expect(c.cloud?.hostSuffix).toBe('musterd.dev');
    // Behind Cloudflare + Fly every request arrives from a proxy (spec §5.1).
    expect(c.trustProxy).toBe(true);
    expect(c.dbPath).toBe('postgres');
    expect(c.traceDbPath).toBe('postgres');
  });
});
