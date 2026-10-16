import { makeEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { findGateAsk, gateAskHumanAnswer } from './gateAsk.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
  return { db, team, nick, ada };
}

/** Insert a gate-ask (species:approve, tier:blocking, meta.gate) as `from`. */
async function ask(
  db: Database,
  team: TeamRow,
  from: MemberRow,
  id: string,
  fingerprint: string,
  ts: number,
): void {
  const env = makeEnvelope({
    id,
    team: team.slug,
    from: from.name,
    to: { kind: 'team' },
    act: 'ask',
    body: `approve me`,
    meta: { species: 'approve', tier: 'blocking', gate: { class: 'merge-to-main', fingerprint } },
    ts,
  });
  await insertMessage(db, team.id, from.id, null, env);
}

/** Insert an accept/decline naming `askId` via meta.in_reply_to, as `from`. */
async function answer(
  db: Database,
  team: TeamRow,
  from: MemberRow,
  act: 'accept' | 'decline',
  id: string,
  askId: string,
  ts: number,
): void {
  const env = makeEnvelope({
    id,
    team: team.slug,
    from: from.name,
    to: { kind: 'member', name: from.name },
    act,
    meta: { in_reply_to: askId },
    ts,
  });
  await insertMessage(db, team.id, from.id, from.id, env);
}

withDrivers('gateAsk', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('findGateAsk (fingerprint dedup anchor)', async () => {
    it('finds the gate-ask carrying the fingerprint', async () => {
      const { db, team, ada } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      expect(await findGateAsk(db, team.id, 'fp-abc')).toMatchObject({ id: 'ask-1' });
    });

    it('returns null when no ask carries the fingerprint', async () => {
      const { db, team, ada } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      expect(await findGateAsk(db, team.id, 'fp-other')).toBeNull();
    });

    it('returns the newest when the same fingerprint was raised more than once', async () => {
      const { db, team, ada } = await seed();
      await ask(db, team, ada, 'ask-old', 'fp-abc', 1_000);
      await ask(db, team, ada, 'ask-new', 'fp-abc', 2_000);
      expect(await findGateAsk(db, team.id, 'fp-abc')).toMatchObject({
        id: 'ask-new',
      });
    });

    it('is scoped to the team', async () => {
      const { db, team } = await seed();
      const other = await createTeam(db, { slug: 'other' });
      const otherAgent = (await addMember(db, other, { name: 'zed', kind: 'agent' })).row;
      await ask(db, other, otherAgent, 'ask-x', 'fp-abc', 1_000);
      expect(await findGateAsk(db, team.id, 'fp-abc')).toBeNull();
    });
  });

  describe('gateAskHumanAnswer (human-only release signal)', async () => {
    it('ignores an A1 channel answer written as an accept (ADR 623 §4): it releases nothing', async () => {
      const { db, team, ada, nick } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      await insertMessage(
        db,
        team.id,
        nick.id,
        nick.id,
        makeEnvelope({
          id: 'ans-a1',
          team: team.slug,
          from: nick.name,
          to: { kind: 'member', name: nick.name },
          act: 'accept',
          meta: {
            in_reply_to: 'ask-1',
            channel_answer: { channel: 'slack', assurance: 'A1', decision: 'approve' },
          },
          ts: 2_000,
        }),
      );
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
    });

    it('still releases on a plain human accept that follows an ignored A1 one', async () => {
      const { db, team, ada, nick } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      await insertMessage(
        db,
        team.id,
        nick.id,
        nick.id,
        makeEnvelope({
          id: 'ans-a1',
          team: team.slug,
          from: nick.name,
          to: { kind: 'member', name: nick.name },
          act: 'decline',
          meta: { in_reply_to: 'ask-1', channel_answer: { channel: 'slack', assurance: 'A1' } },
          ts: 2_000,
        }),
      );
      await answer(db, team, nick, 'accept', 'ans-plain', 'ask-1', 3_000);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toMatchObject({
        act: 'accept',
        by: 'nick',
      });
    });

    it('returns a human accept naming the ask', async () => {
      const { db, team, ada, nick } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      await answer(db, team, nick, 'accept', 'ans-1', 'ask-1', 2_000);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toMatchObject({
        act: 'accept',
        by: 'nick',
      });
    });

    it('returns a human decline naming the ask', async () => {
      const { db, team, ada, nick } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      await answer(db, team, nick, 'decline', 'ans-1', 'ask-1', 2_000);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toMatchObject({
        act: 'decline',
        by: 'nick',
      });
    });

    it('ignores an AGENT accept — only a human releases the gate', async () => {
      const { db, team, ada } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      await answer(db, team, ada, 'accept', 'ans-1', 'ask-1', 2_000);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
    });

    it('ignores an answer naming a different ask', async () => {
      const { db, team, ada, nick } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      await answer(db, team, nick, 'accept', 'ans-1', 'ask-OTHER', 2_000);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
    });

    it('takes the earliest answer when both a decline and a later accept exist', async () => {
      const { db, team, ada, nick } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      await answer(db, team, nick, 'decline', 'ans-decline', 'ask-1', 2_000);
      await answer(db, team, nick, 'accept', 'ans-accept', 'ask-1', 3_000);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toMatchObject({
        act: 'decline',
        by: 'nick',
      });
    });

    it('returns null when the ask is unanswered', async () => {
      const { db, team, ada } = await seed();
      await ask(db, team, ada, 'ask-1', 'fp-abc', 1_000);
      expect(await gateAskHumanAnswer(db, team.id, 'ask-1')).toBeNull();
    });
  });
});
