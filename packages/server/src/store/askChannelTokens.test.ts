import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  issueAskChannelToken,
  NO_BINDING_STORE,
  redeemAskChannelToken,
  type AskStanding,
  type RedemptionChecks,
} from './askChannelTokens.js';
import { listAudit } from './audit.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  return { db, team };
}

const GOOD_ASK: AskStanding = { open: true, digest: 'digest-1', actionClass: 'advisory' };

function checks(over: Partial<{ ask: AskStanding | null; binding: 'current' | 'stale' }> = {}) {
  const calls = { ask: 0, binding: 0 };
  const c: RedemptionChecks = {
    askStanding: async () => {
      calls.ask++;
      return over.ask === undefined ? GOOD_ASK : over.ask;
    },
    bindingStanding: async () => {
      calls.binding++;
      return over.binding ?? 'current';
    },
    bindingAuthorizer: async (_t, _teamId, _bindingId, _generation, channel) => ({
      memberId: 'member-nick',
      memberName: 'nick',
      channel,
      providerTenantId: 'T1',
      providerUserId: 'U1',
    }),
  };
  return { c, calls };
}

function issueInput(teamId: string, over: Record<string, unknown> = {}) {
  return {
    teamId,
    askId: 'ask-1',
    askDigest: 'digest-1',
    actionClass: 'advisory' as const,
    channel: 'slack',
    bindingId: 'bind-1',
    bindingGeneration: 3,
    requiredAssurance: 'A1' as const,
    expiresAt: NOW + 5 * MINUTE,
    now: NOW,
    ...over,
  };
}

function redeemInput(teamId: string, token: string, over: Record<string, unknown> = {}) {
  let wrote = 0;
  const input = {
    teamId,
    token,
    askId: 'ask-1',
    assurance: 'A1' as const,
    decision: 'approve' as const,
    answerMessageId: 'msg-1',
    providerIdentity: { tenantId: 'T1', userId: 'U1' },
    deliveryActor: 'relay',
    now: NOW + MINUTE,
    writeAnswer: async () => {
      wrote++;
    },
    ...over,
  };
  return { input, wrote: () => wrote };
}

async function decisionRows(db: Driver, teamId: string) {
  return db.all<{ ask_id: string; decision: string; message_id: string }>(
    'SELECT ask_id, decision, message_id FROM ask_decisions WHERE team_id = ?',
    [teamId],
  );
}

withDrivers('ask channel tokens and the decision record (ADR 623 §5-§7)', (open) => {
  beforeEach(() => {
    openStore = open;
  });

  describe('issue', () => {
    it('stores only the hash of the token, never the token', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      expect(token.length).toBeGreaterThanOrEqual(32);
      const rows = await db.all<Record<string, unknown>>('SELECT * FROM ask_channel_tokens');
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]!['token_hash']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('issues a different token every time', async () => {
      const { db, team } = await seed();
      const a = await issueAskChannelToken(db, issueInput(team.id));
      const b = await issueAskChannelToken(db, issueInput(team.id, { channel: 'discord' }));
      expect(a.token).not.toEqual(b.token);
    });

    it('refuses an A1 token for a privileged ask (no buttons) and an A2 token for an advisory one', async () => {
      const { db, team } = await seed();
      await expect(
        issueAskChannelToken(db, issueInput(team.id, { actionClass: 'privileged' })),
      ).rejects.toThrow(/privileged/);
      await expect(
        issueAskChannelToken(db, issueInput(team.id, { requiredAssurance: 'A2' })),
      ).rejects.toThrow(/A2/);
      expect(await db.all('SELECT 1 FROM ask_channel_tokens')).toHaveLength(0);
    });

    it('issues an A2 token for a privileged ask (ADR 694)', async () => {
      const { db, team } = await seed();
      await issueAskChannelToken(
        db,
        issueInput(team.id, { actionClass: 'privileged', requiredAssurance: 'A2' }),
      );
      expect(
        await db.all('SELECT action_class, required_assurance FROM ask_channel_tokens'),
      ).toEqual([{ action_class: 'privileged', required_assurance: 'A2' }]);
    });
  });

  describe('redeem', () => {
    it('records one decision, writes the answer inside the transaction, consumes the token and audits', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks();
      let sawDecisionInsideWrite = false;
      const { input } = redeemInput(team.id, token, {
        writeAnswer: async (t: Driver) => {
          const row = await t.get('SELECT 1 AS n FROM ask_decisions WHERE ask_id = ?', ['ask-1']);
          sawDecisionInsideWrite = row !== undefined;
        },
      });
      const result = await redeemAskChannelToken(db, input, c);
      expect(result).toEqual({ ok: true, decision: 'approve', messageId: 'msg-1' });
      expect(sawDecisionInsideWrite).toBe(true);
      expect(await decisionRows(db, team.id)).toEqual([
        { ask_id: 'ask-1', decision: 'approve', message_id: 'msg-1' },
      ]);
      const tok = await db.get<{ consumed_at: number | null }>(
        'SELECT consumed_at FROM ask_channel_tokens WHERE ask_id = ?',
        ['ask-1'],
      );
      expect(tok!.consumed_at).toBe(NOW + MINUTE);
      const audit = (await listAudit(db, team.id)).filter((r) => r.action.startsWith('channel.'));
      expect(audit.map((r) => r.action)).toEqual(['channel.answer.advisory']);
      const detail = JSON.parse(audit[0]!.detail!);
      expect(detail).toMatchObject({
        ask: 'ask-1',
        channel: 'slack',
        assurance: 'A1',
        authorizer: 'nick',
        delivery_actor: 'relay',
        binding_id: 'bind-1',
        binding_generation: 3,
      });
      expect(JSON.stringify(detail)).not.toContain(token);
    });

    it('a second redemption of the same token is refused as consumed', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks();
      const first = await redeemAskChannelToken(db, redeemInput(team.id, token).input, c);
      const second = await redeemAskChannelToken(
        db,
        redeemInput(team.id, token, { answerMessageId: 'msg-2' }).input,
        c,
      );
      expect(first.ok).toBe(true);
      expect(second).toEqual({ ok: false, reason: 'consumed' });
      expect(await decisionRows(db, team.id)).toHaveLength(1);
    });

    it('two channels racing opposite buttons on one ask yield exactly one decision', async () => {
      const { db, team } = await seed();
      const slack = await issueAskChannelToken(db, issueInput(team.id, { channel: 'slack' }));
      const discord = await issueAskChannelToken(db, issueInput(team.id, { channel: 'discord' }));
      const { c } = checks();
      const [a, b] = await Promise.all([
        redeemAskChannelToken(
          db,
          redeemInput(team.id, slack.token, { decision: 'approve', answerMessageId: 'm-a' }).input,
          c,
        ),
        redeemAskChannelToken(
          db,
          redeemInput(team.id, discord.token, { decision: 'reject', answerMessageId: 'm-b' }).input,
          c,
        ),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a;
      expect(loser).toEqual({ ok: false, reason: 'conflict' });
      expect(await decisionRows(db, team.id)).toHaveLength(1);
    });

    it('both buttons of one token racing yield exactly one decision', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks();
      const [a, b] = await Promise.all([
        redeemAskChannelToken(
          db,
          redeemInput(team.id, token, { decision: 'approve', answerMessageId: 'm-a' }).input,
          c,
        ),
        redeemAskChannelToken(
          db,
          redeemInput(team.id, token, { decision: 'reject', answerMessageId: 'm-b' }).input,
          c,
        ),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect(await decisionRows(db, team.id)).toHaveLength(1);
    });

    it('refuses an expired token and writes nothing', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks();
      const { input, wrote } = redeemInput(team.id, token, { now: NOW + 5 * MINUTE });
      expect(await redeemAskChannelToken(db, input, c)).toEqual({ ok: false, reason: 'expired' });
      expect(wrote()).toBe(0);
      expect(await decisionRows(db, team.id)).toHaveLength(0);
    });

    it('refuses an ask whose revision changed since the token was issued', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks({ ask: { ...GOOD_ASK, digest: 'digest-2' } });
      const { input, wrote } = redeemInput(team.id, token);
      expect(await redeemAskChannelToken(db, input, c)).toEqual({
        ok: false,
        reason: 'stale_revision',
      });
      expect(wrote()).toBe(0);
    });

    it('refuses an ask that became privileged after delivery (class recomputed from current state)', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks({ ask: { ...GOOD_ASK, actionClass: 'privileged' } });
      expect(await redeemAskChannelToken(db, redeemInput(team.id, token).input, c)).toEqual({
        ok: false,
        reason: 'class_changed',
      });
      expect(await decisionRows(db, team.id)).toHaveLength(0);
    });

    it('refuses an ask that is no longer open (answered elsewhere) as a conflict', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks({ ask: { ...GOOD_ASK, open: false } });
      expect(await redeemAskChannelToken(db, redeemInput(team.id, token).input, c)).toEqual({
        ok: false,
        reason: 'conflict',
      });
    });

    it('refuses a stale binding generation', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks({ binding: 'stale' });
      expect(await redeemAskChannelToken(db, redeemInput(team.id, token).input, c)).toEqual({
        ok: false,
        reason: 'binding_stale',
      });
    });

    it('fails closed with no_binding_store until the pairing lane provides one', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const result = await redeemAskChannelToken(db, redeemInput(team.id, token).input, {
        askStanding: async () => GOOD_ASK,
        bindingStanding: NO_BINDING_STORE,
        bindingAuthorizer: async () => null,
      });
      expect(result).toEqual({ ok: false, reason: 'no_binding_store' });
      expect(await decisionRows(db, team.id)).toHaveLength(0);
    });

    it('refuses a token from another team as unknown (never leaks that it exists)', async () => {
      const { db, team } = await seed();
      const other = await createTeam(db, { slug: 'other' });
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks();
      expect(await redeemAskChannelToken(db, redeemInput(other.id, token).input, c)).toEqual({
        ok: false,
        reason: 'unknown_token',
      });
      expect(await redeemAskChannelToken(db, redeemInput(team.id, 'not-a-token').input, c)).toEqual(
        {
          ok: false,
          reason: 'unknown_token',
        },
      );
    });

    it('refuses an assurance the token does not allow: A1 never redeems A2, nor A2 an A1 token', async () => {
      const { db, team } = await seed();
      const { c } = checks({ ask: { ...GOOD_ASK, actionClass: 'privileged' } });
      const a2Required = await issueAskChannelToken(
        db,
        issueInput(team.id, {
          askId: 'ask-2',
          actionClass: 'privileged',
          requiredAssurance: 'A2',
        }),
      );
      expect(
        await redeemAskChannelToken(
          db,
          redeemInput(team.id, a2Required.token, { askId: 'ask-2' }).input,
          c,
        ),
      ).toEqual({ ok: false, reason: 'assurance' });
      const a1 = await issueAskChannelToken(db, issueInput(team.id, { askId: 'ask-3' }));
      expect(
        await redeemAskChannelToken(
          db,
          redeemInput(team.id, a1.token, { assurance: 'A2' }).input,
          c,
        ),
      ).toEqual({ ok: false, reason: 'assurance' });
    });

    it('redeems a privileged ask only at A2, and audits it as channel.answer.a2 (ADR 694)', async () => {
      const { db, team } = await seed();
      const { c } = checks({ ask: { ...GOOD_ASK, actionClass: 'privileged' } });
      const { token } = await issueAskChannelToken(
        db,
        issueInput(team.id, { actionClass: 'privileged', requiredAssurance: 'A2' }),
      );
      const ok = await redeemAskChannelToken(
        db,
        redeemInput(team.id, token, { assurance: 'A2' }).input,
        c,
      );
      expect(ok).toEqual({ ok: true, decision: 'approve', messageId: 'msg-1' });
      const audit = await listAudit(db, team.id, { limit: 10 });
      expect(audit.map((r) => r.action)).toContain('channel.answer.a2');
    });

    it('preflight runs every check and writes nothing: no decision, no answer, token still live', async () => {
      const { db, team } = await seed();
      const { c } = checks();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const pre = redeemInput(team.id, token, { preflight: true });
      expect((await redeemAskChannelToken(db, pre.input, c)).ok).toBe(true);
      expect(pre.wrote()).toBe(0);
      expect(await decisionRows(db, team.id)).toHaveLength(0);
      expect((await redeemAskChannelToken(db, redeemInput(team.id, token).input, c)).ok).toBe(true);
      // A preflight that fails refuses with the same reason redemption would.
      const stale = checks({ binding: 'stale' });
      const { token: t2 } = await issueAskChannelToken(db, issueInput(team.id, { askId: 'ask-9' }));
      expect(
        await redeemAskChannelToken(
          db,
          redeemInput(team.id, t2, { askId: 'ask-9', preflight: true }).input,
          stale.c,
        ),
      ).toEqual({ ok: false, reason: 'binding_stale' });
    });

    it('rolls everything back when writing the answer fails: no decision, token still usable', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks();
      await expect(
        redeemAskChannelToken(
          db,
          redeemInput(team.id, token, {
            writeAnswer: async () => {
              throw new Error('disk full');
            },
          }).input,
          c,
        ),
      ).rejects.toThrow(/disk full/);
      expect(await decisionRows(db, team.id)).toHaveLength(0);
      const retry = await redeemAskChannelToken(db, redeemInput(team.id, token).input, c);
      expect(retry.ok).toBe(true);
    });

    it('audits a refusal with its reason and never the token, hash or body', async () => {
      const { db, team } = await seed();
      const { token } = await issueAskChannelToken(db, issueInput(team.id));
      const { c } = checks({ binding: 'stale' });
      await redeemAskChannelToken(db, redeemInput(team.id, token).input, c);
      const hash = (await db.get<{ token_hash: string }>(
        'SELECT token_hash FROM ask_channel_tokens',
      ))!.token_hash;
      const rows = (await listAudit(db, team.id)).filter((r) => r.action.startsWith('channel.'));
      expect(rows.map((r) => r.action)).toEqual(['channel.answer.refused']);
      expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ reason: 'binding_stale', ask: 'ask-1' });
      expect(rows[0]!.detail).not.toContain(token);
      expect(rows[0]!.detail).not.toContain(hash);
    });
  });
});
