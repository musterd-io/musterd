import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { recordPairingIdentity } from '../store/channelBindings.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('channels-http (ADR 618 §7 pairing)', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let nick: string;
  let ada: AgentHttpAuth;

  async function call(method: string, path: string, auth: string | AgentHttpAuth, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${typeof auth === 'string' ? auth : auth.key}`,
        ...(typeof auth === 'object'
          ? { 'x-musterd-session-lease': auth.sessionLease, 'x-musterd-seat': 'ada' }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
    const team = await call('POST', '/teams', '', {
      slug: 'dawn',
      creator: { name: 'nick', kind: 'human' },
    });
    nick = team.json.human_credential;
    await call('POST', '/teams/dawn/members', nick, { name: 'ada', kind: 'agent' });
    ada = await claimAgentHttp(base, 'dawn', team.json.agent_key, nick, 'ada');
  });

  afterEach(async () => {
    await server.close();
  });

  it('pair → stage → confirm → revoke over HTTP, with the daemon-held identity on confirm', async () => {
    const started = await call('POST', '/teams/dawn/channels/pairing/start', nick, {
      channel: 'slack',
    });
    expect(started.status).toBe(201);
    expect(started.json.nonce).toBeTruthy();
    expect(started.json.check_code).toMatch(/^\d{2}$/);

    // Staging binds nothing; the pending list is what the confirmation surface renders.
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    await recordPairingIdentity(server.store, {
      nonce: started.json.nonce,
      providerTenantId: 'T1',
      providerUserId: 'U1',
    });
    const pending = await call('GET', '/teams/dawn/channels/pairings', nick);
    expect(pending.json.pairings).toHaveLength(1);
    expect(pending.json.pairings[0]).toMatchObject({
      provider_tenant_id: 'T1',
      provider_user_id: 'U1',
      team_id: team.id,
    });
    expect(JSON.stringify(pending.json)).not.toContain(started.json.nonce);

    const confirmed = await call(
      'POST',
      `/teams/dawn/channels/pairings/${started.json.pairing_id}/confirm`,
      nick,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.binding).toMatchObject({ generation: 1, status: 'active' });

    const bindings = await call('GET', '/teams/dawn/channels/bindings', nick);
    expect(bindings.json.bindings).toHaveLength(1);

    const revoked = await call(
      'POST',
      `/teams/dawn/channels/bindings/${confirmed.json.binding.id}/revoke`,
      nick,
    );
    expect(revoked.status).toBe(200);
    const after = await call('GET', '/teams/dawn/channels/bindings', nick);
    expect(after.json.bindings[0].status).toBe('revoked');
  });

  it('channel settings default off and round-trip over HTTP', async () => {
    const before = await call('GET', '/teams/dawn/channels/settings', nick);
    expect(before.json.settings).toContainEqual({
      channel: 'slack',
      deliver: false,
      answer: false,
      presenceGating: true,
      tierFloor: null,
    });
    const saved = await call('PUT', '/teams/dawn/channels/settings/slack', nick, {
      deliver: true,
      answer: false,
      presence_gating: false,
      tier_floor: 'standard',
    });
    expect(saved.status).toBe(200);
    expect(saved.json.settings).toMatchObject({
      channel: 'slack',
      deliver: true,
      answer: false,
      tierFloor: 'standard',
    });
    const after = await call('GET', '/teams/dawn/channels/settings', nick);
    expect(after.json.settings).toContainEqual(saved.json.settings);
    // An agent seat has no channel settings of its own to write.
    const refused = await call('PUT', '/teams/dawn/channels/settings/slack', ada, {
      deliver: true,
      answer: true,
      presence_gating: true,
      tier_floor: null,
    });
    expect(refused.status).toBe(403);
  });

  it('an agent seat cannot start a pairing, and the kill switch answers over HTTP', async () => {
    const refused = await call('POST', '/teams/dawn/channels/pairing/start', ada, {
      channel: 'slack',
    });
    expect(refused.status).toBe(403);
    const killed = await call('POST', '/teams/dawn/channels/kill-switch', nick);
    expect(killed.status).toBe(200);
    expect(killed.json).toMatchObject({ bindingsRevoked: 0, tokensRevoked: 0 });
  });
});
