import { makeEnvelope, RELAY_PING_INTERVAL_MS, RELAY_SILENT_MS } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { askDigest, issueAskChannelToken } from '../store/askChannelTokens.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';
import {
  buildRelayPending,
  handleRelayCallback,
  relaySocketUrl,
  startRelayHeartbeat,
} from './relay.js';

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

  it('refuses callbacks outside the configured adapter format', async () => {
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
    expect(result).toEqual({ ok: false, reason: 'unparseable_callback' });
    const pairing = await handleRelayCallback(
      ctx,
      team,
      {
        protocol: 1,
        type: 'callback',
        ask_ref: 'ask-1',
        body: JSON.stringify({
          pairing_nonce: 'nonce-1',
          provider_tenant_id: 'T-attacker',
          provider_user_id: 'U-attacker',
        }),
      },
      NOW + 1_000,
    );
    expect(pairing).toEqual({ ok: false, reason: 'unparseable_callback' });
    expect(await ctx.db.all('SELECT 1 FROM ask_decisions')).toHaveLength(0);
    expect(
      await ctx.db.all("SELECT 1 FROM pairing_nonces WHERE provider_user_id = 'U-attacker'"),
    ).toHaveLength(0);
  });

  it('the socket URL is the per-team connect route over wss', () => {
    expect(relaySocketUrl('https://relay.example/base', 'revive').href).toBe(
      'wss://relay.example/teams/revive/connect',
    );
    // A wss:// policy URL (which the CLI accepts) stays wss — never downgraded to plaintext.
    expect(relaySocketUrl('wss://relay.example/base', 'revive').href).toBe(
      'wss://relay.example/teams/revive/connect',
    );
  });

  it('a plaintext relay URL is refused, never dialed with the credential', () => {
    expect(() => relaySocketUrl('http://relay.example/base', 'revive')).toThrow(
      /refusing to send the relay credential/,
    );
    expect(() => relaySocketUrl('ws://relay.example/base', 'revive')).toThrow(
      /refusing to send the relay credential/,
    );
  });
});

describe('relay heartbeat (ADR 756)', () => {
  afterEach(() => vi.useRealTimers());

  it('pings on the interval while the relay answers, and never calls the socket silent', () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const silent = vi.fn();
    const beat = startRelayHeartbeat({ ping, silent });
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
      beat.heard();
    }
    expect(ping).toHaveBeenCalledTimes(10);
    expect(silent).not.toHaveBeenCalled();
    beat.stop();
  });

  it('a socket that hears nothing past the window is called silent once, then pings stop', () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const silent = vi.fn();
    startRelayHeartbeat({ ping, silent });
    vi.advanceTimersByTime(RELAY_SILENT_MS + RELAY_PING_INTERVAL_MS * 3);
    expect(silent).toHaveBeenCalledTimes(1);
    expect(silent.mock.calls[0]![0]).toBeGreaterThan(RELAY_SILENT_MS);
    const pingsAtSilence = ping.mock.calls.length;
    vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS * 5);
    expect(ping).toHaveBeenCalledTimes(pingsAtSilence);
  });

  it('stop ends the heartbeat: no ping, no silence', () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const silent = vi.fn();
    startRelayHeartbeat({ ping, silent }).stop();
    vi.advanceTimersByTime(RELAY_SILENT_MS * 3);
    expect(ping).not.toHaveBeenCalled();
    expect(silent).not.toHaveBeenCalled();
  });
});
