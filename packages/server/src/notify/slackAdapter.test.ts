import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { askDigest, issueAskChannelToken } from '../store/askChannelTokens.js';
import { listAudit } from '../store/audit.js';
import { confirmPairing, recordPairingIdentity, startPairing } from '../store/channelBindings.js';
import { setChannelSettings } from '../store/channelSettings.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';
import { handleRelayCallback } from './relay.js';
import { parseSlackCallback, renderSlackDelivery } from './slackAdapter.js';

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

function slackBody(payload: unknown): string {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
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
  // Pair nick's Slack identity (T1/U1) the way pairing does: stage, then confirm.
  const { pairing, nonce } = await startPairing(db, {
    teamId: team.id,
    memberId: nick.id,
    actor: 'nick',
    channel: 'slack',
    now: NOW,
  });
  await recordPairingIdentity(db, {
    nonce,
    providerTenantId: 'T1',
    providerUserId: 'U1',
    now: NOW,
  });
  const confirmed = await confirmPairing(db, {
    teamId: team.id,
    memberId: nick.id,
    actor: 'nick',
    pairingId: pairing.id,
    now: NOW,
  });
  if (!confirmed.ok) throw new Error(confirmed.reason);
  // Channel settings default to off; the answering human has opted in.
  await setChannelSettings(db, {
    teamId: team.id,
    memberId: nick.id,
    actor: 'nick',
    settings: {
      channel: 'slack',
      deliver: true,
      answer: true,
      presenceGating: false,
      tierFloor: null,
    },
  });
  const stored = await db.get<{ body: string; meta: string | null }>(
    'SELECT body, meta FROM messages WHERE team_id = ? AND id = ?',
    [team.id, 'ask-1'],
  );
  const { token } = await issueAskChannelToken(db, {
    teamId: team.id,
    askId: 'ask-1',
    askDigest: askDigest(stored!.body, stored!.meta),
    actionClass: 'advisory',
    channel: 'slack',
    bindingId: confirmed.binding.id,
    bindingGeneration: confirmed.binding.generation,
    requiredAssurance: 'A1',
    expiresAt: NOW + 60_000,
    now: NOW,
  });
  return { db, team, ctx: stubCtx(db), token, binding: confirmed.binding };
}

withDrivers('slack adapter (ADR 668)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  it('renders an interactive message whose buttons carry the token', () => {
    const rendered = renderSlackDelivery({
      channelUserId: 'U1',
      teamSlug: 'revive',
      from: 'ada',
      body: 'approve?',
      token: 'tok-1',
    });
    const body = JSON.parse(rendered.body) as {
      channel: string;
      blocks: { type: string; elements?: { action_id: string; value: string }[] }[];
    };
    expect(body.channel).toBe('U1');
    const actions = body.blocks.find((b) => b.type === 'actions');
    expect(actions?.elements?.map((e) => [e.action_id, e.value])).toEqual([
      ['musterd_approve', 'tok-1'],
      ['musterd_reject', 'tok-1'],
    ]);
  });

  it('parses an interactivity payload and refuses malformed ones', () => {
    expect(
      parseSlackCallback(
        slackBody({
          team: { id: 'T1' },
          user: { id: 'U1' },
          actions: [{ action_id: 'musterd_approve', value: 'tok-1' }],
        }),
      ),
    ).toEqual({
      providerTenantId: 'T1',
      providerUserId: 'U1',
      token: 'tok-1',
      decision: 'approve',
    });
    expect(parseSlackCallback('payload=not-json')).toBeNull();
    expect(parseSlackCallback('{"token":"x"}')).toBeNull();
  });

  it('a bound user answering redeems as advisory, authored by the binding human', async () => {
    const { team, ctx, token } = await seed();
    const result = await handleRelayCallback(
      ctx,
      team,
      {
        protocol: 1,
        type: 'callback',
        ask_ref: 'ask-1',
        body: slackBody({
          team: { id: 'T1' },
          user: { id: 'U1' },
          actions: [{ action_id: 'musterd_approve', value: token }],
        }),
      },
      NOW + 1_000,
    );
    expect(result).toEqual({ ok: true });
    const audit = (await listAudit(ctx.db, team.id)).filter(
      (r) => r.action === 'channel.answer.advisory',
    );
    expect(audit).toHaveLength(1);
    const detail = JSON.parse(audit[0]!.detail!) as Record<string, unknown>;
    expect(detail).toMatchObject({ authorizer: 'nick', delivery_actor: 'slack', channel: 'slack' });
    expect(detail).not.toHaveProperty('authorized_by');
  });

  it('turning answer off refuses the answer without touching the binding', async () => {
    const { db, team, ctx, token } = await seed();
    const nick = await db.get<{ id: string }>("SELECT id FROM members WHERE name = 'nick'");
    await setChannelSettings(db, {
      teamId: team.id,
      memberId: nick!.id,
      actor: 'nick',
      settings: {
        channel: 'slack',
        deliver: true,
        answer: false,
        presenceGating: false,
        tierFloor: null,
      },
    });
    const result = await handleRelayCallback(
      ctx,
      team,
      {
        protocol: 1,
        type: 'callback',
        ask_ref: 'ask-1',
        body: slackBody({
          team: { id: 'T1' },
          user: { id: 'U1' },
          actions: [{ action_id: 'musterd_approve', value: token }],
        }),
      },
      NOW + 1_000,
    );
    expect(result).toEqual({ ok: false, reason: 'answer_disabled' });
    const decisions = await db.all('SELECT * FROM ask_decisions');
    expect(decisions).toHaveLength(0);
  });

  it('a payload naming an unbound Slack user redeems nothing', async () => {
    const { team, ctx, token } = await seed();
    const result = await handleRelayCallback(
      ctx,
      team,
      {
        protocol: 1,
        type: 'callback',
        ask_ref: 'ask-1',
        body: slackBody({
          team: { id: 'T1' },
          user: { id: 'U-attacker' },
          actions: [{ action_id: 'musterd_approve', value: token }],
        }),
      },
      NOW + 1_000,
    );
    expect(result).toEqual({ ok: false, reason: 'binding_stale' });
  });

  it('refuses a callback route whose ask id differs from the token ask', async () => {
    const { db, team, ctx, token } = await seed();
    const result = await handleRelayCallback(
      ctx,
      team,
      {
        protocol: 1,
        type: 'callback',
        ask_ref: 'ask-other',
        body: slackBody({
          team: { id: 'T1' },
          user: { id: 'U1' },
          actions: [{ action_id: 'musterd_approve', value: token }],
        }),
      },
      NOW + 1_000,
    );

    expect(result).toEqual({ ok: false, reason: 'conflict' });
    expect(await db.all('SELECT 1 FROM ask_decisions')).toHaveLength(0);
    expect(await db.all("SELECT 1 FROM messages WHERE meta LIKE '%channel_answer%'")).toHaveLength(
      0,
    );
  });

  it('checks the callback identity against the issued token', async () => {
    const { db, team, ctx, token } = await seed();
    const bo = (await addMember(db, team, { name: 'bo', kind: 'human' })).row;
    const { pairing, nonce } = await startPairing(db, {
      teamId: team.id,
      memberId: bo.id,
      actor: 'bo',
      channel: 'slack',
      now: NOW,
    });
    await recordPairingIdentity(db, {
      nonce,
      providerTenantId: 'T1',
      providerUserId: 'U2',
      now: NOW,
    });
    const confirmed = await confirmPairing(db, {
      teamId: team.id,
      memberId: bo.id,
      actor: 'bo',
      pairingId: pairing.id,
      now: NOW,
    });
    if (!confirmed.ok) throw new Error(confirmed.reason);

    const result = await handleRelayCallback(
      ctx,
      team,
      {
        protocol: 1,
        type: 'callback',
        ask_ref: 'ask-1',
        body: `extra=x&${slackBody({
          team: { id: 'T1' },
          user: { id: 'U2' },
          actions: [{ action_id: 'musterd_approve', value: token }],
        })}`,
      },
      NOW + 1_000,
    );

    expect(result).toEqual({ ok: false, reason: 'binding_stale' });
    expect(await db.all('SELECT 1 FROM ask_decisions WHERE ask_id = ?', ['ask-1'])).toHaveLength(0);
    expect(await db.all("SELECT 1 FROM messages WHERE meta LIKE '%channel_answer%'")).toHaveLength(
      0,
    );
  });

  it('a pairing callback stages the identity and binds nothing', async () => {
    const { db, team, ctx } = await seed();
    const nick = await db.get<{ id: string }>("SELECT id FROM members WHERE name = 'nick'");
    const { nonce } = await startPairing(db, {
      teamId: team.id,
      memberId: nick!.id,
      actor: 'nick',
      channel: 'slack',
      now: NOW,
    });
    const result = await handleRelayCallback(
      ctx,
      team,
      {
        protocol: 1,
        type: 'callback',
        ask_ref: 'ask-1',
        body: slackBody({
          team: { id: 'T9' },
          user: { id: 'U9' },
          actions: [{ action_id: 'musterd_pair', value: JSON.stringify({ pairing_nonce: nonce }) }],
        }),
      },
      NOW + 1_000,
    );
    expect(result).toEqual({ ok: true });
    const staged = await db.get<{ state: string; provider_tenant_id: string }>(
      "SELECT state, provider_tenant_id FROM pairing_nonces WHERE state = 'awaiting_confirmation' AND provider_tenant_id = 'T9'",
    );
    expect(staged).toBeTruthy();
  });
});
