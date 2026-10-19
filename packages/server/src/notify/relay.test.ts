import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { issueAskChannelToken } from '../store/askChannelTokens.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';
import { buildRelayPending, handleRelayCallback, relaySocketUrl } from './relay.js';

const NOW = 1_800_000_000_000;

let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: { presenceTimeoutMs: 60_000 } as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'ada', kind: 'agent', role: '' })).row;
  await insertMessage(
    db,
    team.id,
    ada.id,
    nick.id,
    makeEnvelope({
      id: 'ask-1',
      team: team.slug,
      from: 'ada',
      to: { kind: 'member', name: 'nick' },
      act: 'ask',
      body: 'approve?',
      meta: { species: 'consult', tier: 'standard' },
      ts: NOW,
    }),
  );
  const { token } = await issueAskChannelToken(db, {
    teamId: team.id,
    askId: 'ask-1',
    askDigest: 'd1',
    actionClass: 'advisory',
    channel: 'slack',
    bindingId: 'bind-1',
    bindingGeneration: 1,
    requiredAssurance: 'A1',
    expiresAt: NOW + 60_000,
    now: NOW,
  });
  return { db, team, ctx: stubCtx(db), token };
}

withDrivers('away relay client (ADR 659)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  it('builds the pending set from live tokens only, one stable dedupe per ask', async () => {
    const { db, team } = await seed();
    expect(await buildRelayPending(db, team.id, NOW + 1_000)).toEqual([
      { ask_ref: 'ask-1', dedupe_id: 'ask-1:slack', expires_at: NOW + 60_000 },
    ]);
    // After expiry the ask leaves the set: a reconnect after a restart drops its relay row.
    expect(await buildRelayPending(db, team.id, NOW + 61_000)).toEqual([]);
  });

  it('a generic callback fails closed until a binding store exists', async () => {
    const { team, ctx, token } = await seed();
    const result = await handleRelayCallback(
      ctx,
      team,
      {
        protocol: 1,
        type: 'callback',
        ask_ref: 'ask-1',
        body: JSON.stringify({ token, decision: 'approve', authorizer: 'nick' }),
      },
      NOW + 1_000,
    );
    expect(result).toEqual({ ok: false, reason: 'no_binding_store' });
    expect(
      await handleRelayCallback(
        ctx,
        team,
        { protocol: 1, type: 'callback', ask_ref: 'ask-1', body: '<xml>provider</xml>' },
        NOW + 1_000,
      ),
    ).toEqual({ ok: false, reason: 'unparseable_callback' });
  });

  it('the socket URL is the per-team connect route over wss', () => {
    expect(relaySocketUrl('https://relay.example/base', 'revive').href).toBe(
      'wss://relay.example/teams/revive/connect',
    );
  });
});
