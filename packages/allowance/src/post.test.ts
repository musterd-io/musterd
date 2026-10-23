import { describe, expect, it, vi } from 'vitest';
import { allowanceTarget, publishAllowance, teamsFromConfig, workspaceFromFile } from './post.js';

const SECRET = 'mscr_known_identity_secret';

describe('allowanceTarget', () => {
  it('uses the one team in bindings and drops knownIdentities', () => {
    const config = {
      bindings: {
        '/a': { team: 'revive', seat: 'TJ' },
        '/b': { team: 'revive', seat: 'nick' },
      },
      knownIdentities: { nick: { key: SECRET } },
    };
    const teams = teamsFromConfig(config);
    expect(teams).toEqual(['revive', 'revive']);
    expect(JSON.stringify(teams)).not.toContain(SECRET);
    const target = allowanceTarget({ env: {}, workspace: null, teamsOnMachine: teams });
    expect(target).toEqual({
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      credential: null,
    });
    expect(JSON.stringify(target)).not.toContain(SECRET);
  });

  it('skips when several teams are on the machine and no workspace names one', () => {
    expect(
      allowanceTarget({
        env: {},
        workspace: null,
        teamsOnMachine: ['revive', 'other'],
      }),
    ).toBeNull();
  });

  it('reads team and server from the workspace file and nothing else', () => {
    const workspace = workspaceFromFile({
      team: 'revive',
      server: 'http://127.0.0.1:4849',
      agent_key: 'mskey_secret',
    });
    expect(workspace).toEqual({ team: 'revive', server: 'http://127.0.0.1:4849' });
    expect(JSON.stringify(workspace)).not.toContain('mskey_secret');
    expect(
      allowanceTarget({ env: {}, workspace, teamsOnMachine: ['other', 'third'] }),
    ).toMatchObject({ team: 'revive', server: 'http://127.0.0.1:4849' });
  });

  it('skips an off-machine server when no credential is set', () => {
    expect(
      allowanceTarget({
        env: { MUSTERD_TEAM: 'revive', MUSTERD_SERVER: 'https://hub.example' },
        workspace: null,
        teamsOnMachine: [],
      }),
    ).toBeNull();
    expect(
      allowanceTarget({
        env: {
          MUSTERD_TEAM: 'revive',
          MUSTERD_SERVER: 'https://hub.example',
          MUSTERD_CREDENTIAL: 'mscr_from_env',
        },
        workspace: null,
        teamsOnMachine: [],
      }),
    ).toEqual({
      server: 'https://hub.example',
      team: 'revive',
      credential: 'mscr_from_env',
    });
  });
});

describe('publishAllowance', () => {
  it('does not call fetch when no team can be chosen', async () => {
    const fetchSub = vi.fn<typeof fetch>();
    await publishAllowance({
      env: {},
      cwd: '/tmp/allowance-no-team',
      configPath: '/tmp/allowance-no-team/config.json',
      body: { accounts: [] },
      fetchSub,
    });
    expect(fetchSub).not.toHaveBeenCalled();
  });
});
