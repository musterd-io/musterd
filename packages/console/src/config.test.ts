import { describe, expect, it } from 'vitest';
import { resolveConsoleConfig } from './config.js';

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
