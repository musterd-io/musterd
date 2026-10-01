import { describe, expect, it } from 'vitest';
import { checkUpgrade } from '../config.js';
import { hostAllows, hostTeam, pathTeam } from './hostIsolation.js';

const SUFFIX = 'musterd.dev';

describe('hostTeam — the team a Cloud Host header names (spec §5.3)', () => {
  it('reads the single label under the suffix, ignoring case and port', () => {
    expect(hostTeam('revive.musterd.dev', SUFFIX)).toBe('revive');
    expect(hostTeam('Revive.Musterd.Dev:443', SUFFIX)).toBe('revive');
  });

  it('names no team for the apex, nested labels, look-alikes, or nothing', () => {
    for (const h of [
      'musterd.dev',
      'a.b.musterd.dev',
      'revive.musterd.dev.evil.com',
      'evilmusterd.dev',
      '127.0.0.1:4849',
      '[::1]:4849',
      '',
      undefined,
    ])
      expect(hostTeam(h, SUFFIX), String(h)).toBeNull();
  });
});

describe('pathTeam — the team a route addresses', () => {
  it.each([
    ['/teams/revive', 'revive'],
    ['/teams/revive/messages', 'revive'],
    ['/teams/re%76ive/members', 'revive'],
    ['/mcp/revive', 'revive'],
    ['/oauth/revive/authorize', 'revive'],
    ['/oauth/revive', 'revive'],
    ['/.well-known/oauth-protected-resource/mcp/revive', 'revive'],
    ['/.well-known/oauth-authorization-server/revive', 'revive'],
    ['/.well-known/oauth-authorization-server/oauth/revive', 'revive'],
    ['/.well-known/openid-configuration/oauth/revive', 'revive'],
    ['/oauth/revive/.well-known/openid-configuration', 'revive'],
  ])('%s → %s', (path, team) => {
    expect(pathTeam(path)).toBe(team);
  });

  it.each(['/health', '/teams', '/live', '/assets/app.js', '/agent-bootstrap-migrations'])(
    '%s is global',
    (path) => {
      expect(pathTeam(path)).toBeNull();
    },
  );
});

describe('hostAllows — a team host reaches only its own team', () => {
  const on = (host: string | undefined, path: string) => hostAllows(host, path, SUFFIX);

  it('its own routes, and the global ones', () => {
    expect(on('revive.musterd.dev', '/teams/revive/messages')).toBe(true);
    expect(on('revive.musterd.dev', '/mcp/revive')).toBe(true);
    expect(on('revive.musterd.dev', '/health')).toBe(true);
    expect(on('musterd.dev', '/health')).toBe(true);
    expect(on('musterd.dev', '/teams')).toBe(true);
  });

  it("never another team's, by any route shape", () => {
    for (const p of [
      '/teams/other/messages',
      '/mcp/other',
      '/oauth/other/token',
      '/.well-known/oauth-protected-resource/mcp/other',
      '/.well-known/oauth-authorization-server/other',
      '/oauth/other/.well-known/openid-configuration',
    ])
      expect(on('revive.musterd.dev', p), p).toBe(false);
  });

  it('a team route on a host that names no team is refused', () => {
    expect(on('musterd.dev', '/teams/revive/messages')).toBe(false);
    expect(on('127.0.0.1:4849', '/teams/revive/messages')).toBe(false);
    expect(on(undefined, '/mcp/revive')).toBe(false);
  });
});

describe('checkUpgrade with a Cloud host suffix', () => {
  const cfg = { boundHost: '0.0.0.0', allowedHosts: [], allowedOrigins: [], hostSuffix: SUFFIX };

  it('admits team hosts under the suffix, with or without a browser Origin', () => {
    expect(checkUpgrade({ host: 'revive.musterd.dev' }, cfg).ok).toBe(true);
    expect(
      checkUpgrade({ host: 'revive.musterd.dev', origin: 'https://revive.musterd.dev' }, cfg).ok,
    ).toBe(true);
  });

  it('still refuses a host outside it', () => {
    expect(checkUpgrade({ host: 'evil.example' }, cfg).ok).toBe(false);
    expect(checkUpgrade({ host: 'revive.musterd.dev.evil.example' }, cfg).ok).toBe(false);
  });
});
