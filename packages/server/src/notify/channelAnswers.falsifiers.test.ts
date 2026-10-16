import {
  answerAuthority,
  classifyAskAction,
  makeEnvelope,
  type AskActionClass,
} from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { routeEnvelope } from '../protocol/route.js';
import {
  issueAskChannelToken,
  redeemAskChannelToken,
  type AskStanding,
  type RedemptionChecks,
} from '../store/askChannelTokens.js';
import { listAudit } from '../store/audit.js';
import { gateAskHumanAnswer } from '../store/gateAsk.js';
import { getLane, openLane, updateLane } from '../store/lanes.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createRequest, decideRequest } from '../store/requests.js';
import { createTeam } from '../store/teams.js';

/**
 * The away-channels falsifier suite (ADR 618, ADR 623, spec 2026-10-15-away-channels-design.md). Each
 * entry names an attack the design claims to refuse. The ones the daemon now has the code for are real
 * tests; the rest stay `todo` and name the lane that builds what they exercise. A todo still pending
 * when its lane lands fails review.
 */

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const GOOD: AskStanding = { open: true, digest: 'd1', actionClass: 'advisory' };
const CHANNEL = { channel: 'slack', assurance: 'A1', decision: 'approve' };

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
  const bo = (await addMember(db, team, { name: 'bo', kind: 'agent', role: '' })).row;
  return { db, team, nick, ada, bo, ctx: stubCtx(db) };
}

interface CheckOver {
  ask?: AskStanding;
  binding?: 'current' | 'stale';
}

function checks(over: CheckOver = {}): RedemptionChecks {
  return {
    askStanding: async () => over.ask ?? GOOD,
    bindingStanding: async () => over.binding ?? 'current',
  };
}

async function token(db: Driver, teamId: string, over: Record<string, unknown> = {}) {
  return (
    await issueAskChannelToken(db, {
      teamId,
      askId: 'ask-1',
      askDigest: 'd1',
      actionClass: 'advisory',
      channel: 'slack',
      bindingId: 'bind-1',
      bindingGeneration: 1,
      requiredAssurance: 'A1',
      expiresAt: NOW + 5 * MINUTE,
      now: NOW,
      ...over,
    })
  ).token;
}

function redeem(
  db: Driver,
  teamId: string,
  tok: string,
  over: {
    decision?: 'approve' | 'reject';
    answerMessageId?: string;
    checks?: RedemptionChecks;
  } = {},
) {
  return redeemAskChannelToken(
    db,
    {
      teamId,
      token: tok,
      assurance: 'A1',
      decision: over.decision ?? 'approve',
      answerMessageId: over.answerMessageId ?? 'ans-1',
      authorizer: 'nick',
      deliveryActor: 'relay',
      now: NOW + MINUTE,
      writeAnswer: async () => {},
    },
    over.checks ?? checks(),
  );
}

/** A human's accept/decline naming `askId`, optionally dressed as a channel answer. */
async function humanAnswer(
  db: Driver,
  team: { id: string; slug: string },
  nick: { id: string; name: string },
  act: 'accept' | 'decline',
  id: string,
  askId: string,
  channelAnswer?: Record<string, unknown>,
) {
  await insertMessage(
    db,
    team.id,
    nick.id,
    nick.id,
    makeEnvelope({
      id,
      team: team.slug,
      from: nick.name,
      to: { kind: 'member', name: nick.name },
      act,
      meta: { in_reply_to: askId, ...(channelAnswer ? { channel_answer: channelAnswer } : {}) },
      ts: Date.now(),
    }),
  );
}

/** A gate-raised ask (privileged by construction, ADR 150). */
async function gateAsk(
  db: Driver,
  team: { id: string; slug: string },
  ada: { id: string },
  species: string,
) {
  await insertMessage(
    db,
    team.id,
    ada.id,
    null,
    makeEnvelope({
      id: 'ask-1',
      team: team.slug,
      from: 'ada',
      to: { kind: 'team' },
      act: 'ask',
      meta: { species, tier: 'blocking', gate: { class: 'costly-action', fingerprint: 'f' } },
    }),
  );
}

withDrivers('away channels falsifiers', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  describe('a malicious relay (ADR 618 §9)', () => {
    it('forges a provider callback naming the bound user: the answer is advisory, never an authorization', async () => {
      const { db, team, nick, ada } = await seed();
      await gateAsk(db, team, ada, 'approve');
      const tok = await token(db, team.id);
      expect((await redeem(db, team.id, tok)).ok).toBe(true);
      // The relay's best forgery: an accept in the human's name carrying the channel provenance.
      await humanAnswer(db, team, nick, 'accept', 'ans-forged', 'ask-1', CHANNEL);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
      const audit = (await listAudit(db, team.id)).filter((r) => r.action.startsWith('channel.'));
      for (const row of audit) expect(JSON.parse(row.detail!)).not.toHaveProperty('authorized_by');
    });

    it('swaps one ask or action for another: the token binds the ask revision', async () => {
      const { db, team } = await seed();
      const tok = await token(db, team.id);
      const result = await redeem(db, team.id, tok, {
        checks: checks({ ask: { ...GOOD, digest: 'other' } }),
      });
      expect(result).toEqual({ ok: false, reason: 'stale_revision' });
    });

    it('replays an answer after the binding was revoked: refused on the binding generation', async () => {
      const { db, team } = await seed();
      const tok = await token(db, team.id);
      expect(await redeem(db, team.id, tok, { checks: checks({ binding: 'stale' }) })).toEqual({
        ok: false,
        reason: 'binding_stale',
      });
    });

    it('races Approve and Reject on one ask: exactly one decision, never reopened', async () => {
      const { db, team } = await seed();
      const a = await token(db, team.id, { channel: 'slack' });
      const b = await token(db, team.id, { channel: 'discord' });
      const [x, y] = await Promise.all([
        redeem(db, team.id, a, { decision: 'approve', answerMessageId: 'm-a' }),
        redeem(db, team.id, b, { decision: 'reject', answerMessageId: 'm-b' }),
      ]);
      expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
      expect(await db.all('SELECT 1 FROM ask_decisions')).toHaveLength(1);
    });

    it('answers across teams: refused, and indistinguishable from an unknown token', async () => {
      const { db, team } = await seed();
      const other = await createTeam(db, { slug: 'other' });
      const tok = await token(db, team.id);
      expect(await redeem(db, other.id, tok)).toEqual({ ok: false, reason: 'unknown_token' });
    });

    it.todo(
      'pairs a different provider identity: refused without the original-surface confirmation (pairing lane 01M50XPYZ9877E494X2SV1EGTB)',
    );
    it.todo(
      'lies in the confirmation UI: the daemon-held tenant and user, not the relay, are what is shown (pairing lane 01M50XPYZ9877E494X2SV1EGTB)',
    );
    it.todo(
      'answers after the daemon restarted: reconciled from daemon state, expired buttons refused (relay lane 01M50XPXWEFMHND3GABXDSNTVW)',
    );
  });

  describe('the action class (ADR 623 §1, §6)', () => {
    it('a privileged request mislabeled as a consult draws an advisory answer that releases nothing', async () => {
      const { db, team, nick, ada } = await seed();
      // The agent calls a costly, gate-guarded action a "consult". The daemon cannot tell from the
      // species alone, so it classifies the ask advisory and a button is shown (ADR 623 §1)...
      expect(classifyAskAction({ species: 'consult', tier: 'standard' })).toBe('advisory');
      await gateAsk(db, team, ada, 'consult');
      // ...and the answer it draws releases nothing, because the consumers refuse it.
      await humanAnswer(db, team, nick, 'accept', 'ans-a1', 'ask-1', CHANNEL);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
    });

    it('no class lets an A1 answer release work in v1', () => {
      const classes: AskActionClass[] = ['advisory', 'privileged'];
      for (const actionClass of classes) {
        expect(answerAuthority({ action_class: actionClass }, { channel_answer: CHANNEL })).toBe(
          'advisory',
        );
      }
    });

    it('an action that becomes privileged after delivery refuses the answer at redemption', async () => {
      const { db, team } = await seed();
      const tok = await token(db, team.id);
      const result = await redeem(db, team.id, tok, {
        checks: checks({ ask: { ...GOOD, actionClass: 'privileged' } }),
      });
      expect(result).toEqual({ ok: false, reason: 'class_changed' });
      expect(await db.all('SELECT 1 FROM ask_decisions')).toHaveLength(0);
    });

    it('an unknown consequence is privileged (fail closed)', () => {
      expect(classifyAskAction({})).toBe('privileged');
      expect(classifyAskAction({ species: 'something-new' })).toBe('privileged');
      expect(classifyAskAction(null)).toBe('privileged');
    });

    it.todo(
      'a lane whose risk tags are missing or were removed does not become a releasing class (the first releasing class, spec open question 1)',
    );
  });

  describe('consumers enforce assurance (ADR 623 §4)', () => {
    it('the gate release read refuses an A1 answer', async () => {
      const { db, team, nick, ada } = await seed();
      await gateAsk(db, team, ada, 'approve');
      await humanAnswer(db, team, nick, 'accept', 'ans-a1', 'ask-1', CHANNEL);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
    });

    it('acceptance refuses an A1 answer: the lane does not move', async () => {
      const { db, team, nick, ada, bo, ctx } = await seed();
      const lane = await openLane(db, team.id, 'revive', 'ada', { title: 'built', claim: true });
      await updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
      await insertMessage(
        db,
        team.id,
        ada.id,
        bo.id,
        makeEnvelope({
          id: 'ask-1',
          team: team.slug,
          from: 'ada',
          to: { kind: 'member', name: 'bo' },
          act: 'ask',
          body: '[lane] acceptance requested',
          meta: { lane_review: { lane: lane.id }, species: 'approve', tier: 'standard' },
        }),
      );
      await expect(
        routeEnvelope(
          ctx,
          team,
          nick,
          makeEnvelope({
            id: 'verdict',
            team: team.slug,
            from: 'nick',
            to: { kind: 'member', name: 'ada' },
            act: 'accept',
            meta: { in_reply_to: 'ask-1', channel_answer: CHANNEL },
          }),
          undefined,
          true,
        ),
      ).rejects.toSatisfy((e) => e instanceof MusterdError && e.code === 'forbidden');
      expect((await getLane(db, team.id, lane.id))?.state).toBe('awaiting_acceptance');
    });

    it('request.decide refuses a channel decision and leaves the request pending', async () => {
      const { db, team } = await seed();
      const req = await createRequest(db, team.id, {
        kind: 'claim',
        from_session: 's1',
        target: 'seat:ada',
        surface: 'claude-code',
      });
      for (const assurance of ['A1', 'A2'] as const) {
        expect(
          await decideRequest(db, team.id, req.id, 'approved', 'nick', { assurance }),
        ).toBeNull();
      }
    });

    it('an A1 answer is never written as a plain human accept or decline', async () => {
      const { team, nick, ctx } = await seed();
      for (const act of ['accept', 'decline'] as const) {
        await expect(
          routeEnvelope(
            ctx,
            team,
            nick,
            makeEnvelope({
              id: `never-${act}`,
              team: team.slug,
              from: 'nick',
              to: { kind: 'team' },
              act,
              meta: { in_reply_to: 'ask-1', channel_answer: CHANNEL },
            }),
            undefined,
            true,
          ),
        ).rejects.toThrow(/channel answer cannot be an accept or decline/);
      }
    });

    it('an A1 answer to a consult sets no authorized_by', async () => {
      const { db, team } = await seed();
      const tok = await token(db, team.id);
      expect((await redeem(db, team.id, tok)).ok).toBe(true);
      const rows = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'channel.answer.advisory',
      );
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.detail!)).not.toHaveProperty('authorized_by');
    });
  });

  describe('kill switch and audit (ADR 618 §7-§8)', () => {
    it('no audit row carries a raw token, its hash, a signature or a body', async () => {
      const { db, team } = await seed();
      const good = await token(db, team.id);
      const bad = await token(db, team.id, { askId: 'ask-2', channel: 'discord' });
      await redeem(db, team.id, good);
      await redeem(db, team.id, bad, { checks: checks({ binding: 'stale' }) });
      const hashes = (
        await db.all<{ token_hash: string }>('SELECT token_hash FROM ask_channel_tokens')
      ).map((r) => r.token_hash);
      const blob = JSON.stringify(await listAudit(db, team.id));
      for (const secret of [good, bad, ...hashes]) expect(blob).not.toContain(secret);
    });

    it.todo(
      'the kill switch revokes every binding generation and outstanding token without the relay (pairing lane 01M50XPYZ9877E494X2SV1EGTB)',
    );
  });

  describe('shared Slack ingress and tenancy (spec: Slack ingress)', () => {
    it.todo(
      'a request field cannot select the ingress destination: only the install mapping does (Slack adapter lane 01M50XQ04M8E3X5QHY173Q18X7)',
    );
    it.todo(
      'a payload naming another team or enterprise id is dispatched only to its mapped destination (Slack adapter lane 01M50XQ04M8E3X5QHY173Q18X7)',
    );
    it.todo(
      'a receiver refuses a payload with a missing or invalid ingress attestation (Slack adapter lane 01M50XQ04M8E3X5QHY173Q18X7)',
    );
    it.todo(
      'one team daemon credential, object or Slack install cannot read or answer another team (multi-tenant relay lane 01M50ZQCTWM5QBZ083782J9N6R)',
    );
    it.todo(
      'a flood from one team does not starve another team (multi-tenant relay lane 01M50ZQCTWM5QBZ083782J9N6R)',
    );
  });
});
