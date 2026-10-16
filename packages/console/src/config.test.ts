import { describe, expect, it } from 'vitest';
import { buildFromFlyImage, resolveConsoleConfig } from './config.js';

const base = {
  MUSTERD_CONSOLE_DATABASE_URL: 'postgres://console_app:s3cretpw@db.test/console',
  MUSTERD_CONSOLE_ISSUER: 'https://app.musterd.io',
};

describe('resolveConsoleConfig (ADR 615)', () => {
  it('pins the issuer origin and its host', () => {
    const c = resolveConsoleConfig(base);
    expect(c.issuer).toBe('https://app.musterd.io');
    expect(c.allowedHosts).toEqual(['app.musterd.io']);
    expect(c.port).toBe(8080);
  });

  it('names a missing variable and never echoes a value', () => {
    expect(() => resolveConsoleConfig({ ...base, MUSTERD_CONSOLE_DATABASE_URL: '' })).toThrow(
      /MUSTERD_CONSOLE_DATABASE_URL/,
    );
    try {
      resolveConsoleConfig({ ...base, MUSTERD_CONSOLE_DATABASE_URL: 'not a url s3cretpw' });
    } catch (e) {
      expect(String(e)).toContain('MUSTERD_CONSOLE_DATABASE_URL');
      expect(String(e)).not.toContain('s3cretpw');
    }
  });

  it('enables a provider only with both its id and secret, and refuses half a pair', () => {
    expect(resolveConsoleConfig(base).providers).toEqual({});
    const both = resolveConsoleConfig({
      ...base,
      MUSTERD_CONSOLE_GITHUB_CLIENT_ID: 'id',
      MUSTERD_CONSOLE_GITHUB_CLIENT_SECRET: 'sekrit',
    });
    expect(both.providers.github).toEqual({ clientId: 'id', clientSecret: 'sekrit' });
    try {
      resolveConsoleConfig({ ...base, MUSTERD_CONSOLE_GOOGLE_CLIENT_SECRET: 'sekrit' });
      throw new Error('should refuse');
    } catch (e) {
      expect(String(e)).toContain('MUSTERD_CONSOLE_GOOGLE_CLIENT_ID');
      expect(String(e)).not.toContain('sekrit');
    }
  });

  it('turns magic-link email on only with all three variables, and refuses a partial set', () => {
    expect(resolveConsoleConfig(base).email).toBeNull();
    const on = resolveConsoleConfig({
      ...base,
      MUSTERD_CONSOLE_EMAIL_ACCOUNT_ID: 'acct',
      MUSTERD_CONSOLE_EMAIL_API_TOKEN: 'cf-tok',
      MUSTERD_CONSOLE_EMAIL_FROM: 'signin@musterd.io',
    });
    expect(on.email?.fromAddress).toBe('signin@musterd.io');
    try {
      resolveConsoleConfig({ ...base, MUSTERD_CONSOLE_EMAIL_API_TOKEN: 'cf-tok' });
      throw new Error('should refuse');
    } catch (e) {
      expect(String(e)).toContain('MUSTERD_CONSOLE_EMAIL_ACCOUNT_ID');
      expect(String(e)).not.toContain('cf-tok');
    }
  });

  it('falls back to the Fly image label when the dist stamp is null', () => {
    const img = 'registry.fly.io/musterd-console:git-6fd7aca44986';
    expect(resolveConsoleConfig({ ...base, FLY_IMAGE_REF: img }).build).toBe('6fd7aca44986');
    expect(resolveConsoleConfig({ ...base, FLY_IMAGE_REF: img }, 'a'.repeat(40)).build).toBe(
      'a'.repeat(40),
    );
    expect(resolveConsoleConfig(base).build).toBeNull();
  });

  it('reads the git-<sha> label with a digest, and nothing else', () => {
    const digest = `@sha256:${'e'.repeat(64)}`;
    expect(buildFromFlyImage(`registry.fly.io/musterd-cloud:git-60cf546b2e2d${digest}`)).toBe(
      '60cf546b2e2d',
    );
    expect(buildFromFlyImage(undefined)).toBeNull();
    for (const label of ['', 'deployment-01K2ABC', 'git-main', 'git-6fd7aca44986x']) {
      expect(buildFromFlyImage(`registry.fly.io/musterd-console:${label}`)).toBeNull();
    }
  });

  it('refuses an issuer that is not a bare https origin', () => {
    for (const bad of [
      'http://app.musterd.io',
      'https://app.musterd.io/path',
      'https://u:p@app.musterd.io',
      'https://app.musterd.io/?x=1',
    ])
      expect(() => resolveConsoleConfig({ ...base, MUSTERD_CONSOLE_ISSUER: bad })).toThrow(
        /MUSTERD_CONSOLE_ISSUER/,
      );
    expect(
      resolveConsoleConfig({ ...base, MUSTERD_CONSOLE_ISSUER: 'http://localhost:8787' }).issuer,
    ).toBe('http://localhost:8787');
  });
});
