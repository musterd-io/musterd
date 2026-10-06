import { GENERALIST_CAPABILITIES, POLICY_REVIEW_DEFAULT_MS } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAudit } from './audit.js';
import { addMember, getMemberByName, setMemberGovernance } from './members.js';
import {
  answerPolicyReview,
  policyReviewDue,
  policyReviewTick,
  raisePolicyReview,
} from './policyReview.js';
import {
  applyPolicyChange,
  createTeam,
  getStoredPolicy,
  setPolicy,
  stampReviewBy,
} from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('policyReview', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nickRow = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    await setMemberGovernance(
      db,
      nickRow.id,
      null,
      JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
    );
    const nick = (await getMemberByName(db, team.id, 'nick'))!;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    return { db, team, nick, ada };
  }
  const DAY = 86_400_000;

  describe('stampReviewBy (ADR 533)', () => {
    const now = Date.UTC(2026, 9, 6);
    it('a doc with a knob and no date gets the default window; an empty doc gets none', () => {
      expect(stampReviewBy({ ask_fallback_to_nonadmin: true }, now)).toEqual({
        ask_fallback_to_nonadmin: true,
        review_by: now + POLICY_REVIEW_DEFAULT_MS,
      });
      expect(stampReviewBy({}, now)).toEqual({});
      expect(stampReviewBy({ review_by: now + DAY }, now)).toEqual({});
    });
    it('a named date is kept; a past one or one over 365d is refused', () => {
      const d = { ask_fallback_to_nonadmin: true, review_by: now + 10 * DAY };
      expect(stampReviewBy(d, now)).toEqual(d);
      expect(() => stampReviewBy({ ...d, review_by: now }, now)).toThrow(/future/);
      expect(() => stampReviewBy({ ...d, review_by: now + 366 * DAY }, now)).toThrow(/365/);
    });
    it('applyPolicyChange stores the stamp, and the effective policy never carries it', async () => {
      const { db, team } = await seed();
      const { stored, policy } = await applyPolicyChange(db, team.id, 'nick', {
        ask_fallback_to_nonadmin: true,
      });
      expect(stored.review_by).toBeGreaterThan(Date.now());
      expect(policy).not.toHaveProperty('review_by');
    });
  });

  describe('the sweep asks once per due date', () => {
    it('nothing due: a fresh doc, an empty doc', async () => {
      const { db, team } = await seed();
      expect(await policyReviewDue(db, team.id, Date.now())).toBeNull();
      await applyPolicyChange(db, team.id, 'nick', { ask_fallback_to_nonadmin: true });
      expect(await policyReviewDue(db, team.id, Date.now())).toBeNull();
    });

    it('a doc past review_by raises one ask from the policy service seat, then no more', async () => {
      const { db, team } = await seed();
      const past = Date.now() - DAY;
      await setPolicy(db, team.id, { ask_fallback_to_nonadmin: true, review_by: past });
      const sent: unknown[] = [];
      const send = async (_from: unknown, env: unknown) => {
        sent.push(env);
        return {} as never;
      };
      expect(await policyReviewTick(db, Date.now(), send)).toBe(1);
      expect(await policyReviewTick(db, Date.now(), send)).toBe(0);
      expect(sent).toHaveLength(1);
      const env = sent[0] as {
        act: string;
        from: string;
        body: string;
        meta: Record<string, unknown>;
      };
      expect(env.act).toBe('ask');
      expect(env.from).toBe('policy');
      expect(env.meta).toMatchObject({
        species: 'approve',
        tier: 'standard',
        policy_review: { review_by: past, keys: ['ask_fallback_to_nonadmin'] },
      });
      expect(env.body).toContain('ask_fallback_to_nonadmin');
      const seat = await getMemberByName(db, team.id, 'policy');
      expect(seat?.kind).toBe('service');
      const due = (await listAudit(db, team.id)).filter((r) => r.action === 'policy.review_due');
      expect(due).toHaveLength(1);
    });

    it("will not post as somebody's agent when the name is taken", async () => {
      const { db, team } = await seed();
      await addMember(db, team, { name: 'policy', kind: 'agent' });
      await setPolicy(db, team.id, { ask_fallback_to_nonadmin: true, review_by: Date.now() - DAY });
      expect(await raisePolicyReview(db, team, Date.now())).toBeNull();
    });
  });

  describe('a human admin answers', () => {
    async function dueAsk() {
      const s = await seed();
      await setPolicy(s.db, s.team.id, {
        ask_fallback_to_nonadmin: true,
        review_by: Date.now() - DAY,
      });
      let askEnv: { id: string } | null = null;
      await raisePolicyReview(s.db, s.team, Date.now(), async (from, env) => {
        askEnv = env;
        // store the ask row so the answer can find it
        const { insertMessage } = await import('./messages.js');
        return insertMessage(s.db, s.team.id, from.id, null, env);
      });
      return { ...s, askId: askEnv!.id };
    }

    it('accept keeps every knob and moves review_by out by the default window', async () => {
      const { db, team, nick, askId } = await dueAsk();
      const now = Date.now();
      const a = await answerPolicyReview(db, team, nick, askId, 'accept', now);
      expect(a).toEqual({ verdict: 'confirmed', review_by: now + POLICY_REVIEW_DEFAULT_MS });
      expect(await getStoredPolicy(db, team.id)).toEqual({
        ask_fallback_to_nonadmin: true,
        review_by: now + POLICY_REVIEW_DEFAULT_MS,
      });
      // answered once: a second accept changes nothing
      expect(await answerPolicyReview(db, team, nick, askId, 'accept', now + 1)).toBeNull();
      const change = (await listAudit(db, team.id)).filter((r) => r.action === 'policy.change');
      expect(change.at(-1)?.actor).toBe('nick');
    });

    it('decline drops the doc — every default comes back', async () => {
      const { db, team, nick, askId } = await dueAsk();
      const a = await answerPolicyReview(db, team, nick, askId, 'decline');
      expect(a).toEqual({ verdict: 'dropped', review_by: null });
      expect(await getStoredPolicy(db, team.id)).toEqual({});
    });

    it("an agent's answer, or an answer to some other ask, changes nothing", async () => {
      const { db, team, ada, nick, askId } = await dueAsk();
      expect(await answerPolicyReview(db, team, ada, askId, 'decline')).toBeNull();
      expect(await answerPolicyReview(db, team, nick, 'not-an-ask', 'decline')).toBeNull();
      expect(await getStoredPolicy(db, team.id)).toMatchObject({ ask_fallback_to_nonadmin: true });
    });
  });
});
