import { describe, expect, it } from 'vitest';
import {
  installStateLive,
  parseSlackOAuthResponse,
  slackAuthorizeUrl,
  SLACK_INSTALL_SCOPES,
} from './installs.js';
import { parseDaemonFrame } from './relay.js';

describe('slack install flow (ADR 668 decision 2, increment 9)', () => {
  it('builds the authorize URL with exactly the reviewed scopes', () => {
    const url = new URL(
      slackAuthorizeUrl({
        clientId: '123.456',
        redirectUri: 'https://relay.example/slack/oauth',
        state: 'state-at-least-16-chars',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('123.456');
    expect(url.searchParams.get('scope')).toBe(SLACK_INSTALL_SCOPES.join(','));
    expect(url.searchParams.get('redirect_uri')).toBe('https://relay.example/slack/oauth');
    expect(url.searchParams.get('state')).toBe('state-at-least-16-chars');
  });

  it('parses an oauth.v2.access answer; anything else is no install', () => {
    expect(
      parseSlackOAuthResponse({
        ok: true,
        access_token: 'xoxb-token',
        team: { id: 'T1', name: 'Workspace' },
        authed_user: { id: 'U1' },
      }),
    ).toEqual({ slackTeamId: 'T1', botToken: 'xoxb-token', installerSlackId: 'U1' });
    expect(parseSlackOAuthResponse({ ok: false, error: 'invalid_code' })).toBeNull();
    expect(
      parseSlackOAuthResponse({ ok: true, team: { id: 'T1' }, authed_user: { id: 'U1' } }),
    ).toBeNull();
    expect(
      parseSlackOAuthResponse({ ok: true, access_token: 'x', authed_user: { id: 'U1' } }),
    ).toBeNull();
    expect(parseSlackOAuthResponse('nope')).toBeNull();
  });

  it('an install state lives ten minutes and dies on consumption', () => {
    const t0 = 1_800_000_000_000;
    expect(installStateLive(t0, null, t0 + 60_000)).toBe(true);
    expect(installStateLive(t0, null, t0 + 11 * 60_000)).toBe(false);
    expect(installStateLive(t0, t0 + 1_000, t0 + 2_000)).toBe(false);
    expect(installStateLive(0, null, t0)).toBe(false);
  });

  it('parses the install frames and refuses malformed ones', () => {
    expect(parseDaemonFrame(JSON.stringify({ protocol: 1, type: 'install_sync' }))?.type).toBe(
      'install_sync',
    );
    expect(
      parseDaemonFrame(
        JSON.stringify({ protocol: 1, type: 'install_ack', slack_team_ids: ['T1'] }),
      ),
    ).toEqual({ protocol: 1, type: 'install_ack', slack_team_ids: ['T1'] });
    expect(
      parseDaemonFrame(JSON.stringify({ protocol: 1, type: 'install_ack', slack_team_ids: [42] })),
    ).toBeNull();
    expect(
      parseDaemonFrame(
        JSON.stringify({
          protocol: 1,
          type: 'install_ack',
          slack_team_ids: Array.from({ length: 33 }, (_, i) => `T${i}`),
        }),
      ),
    ).toBeNull();
  });
});
