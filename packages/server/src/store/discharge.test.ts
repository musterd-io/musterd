import { makeEnvelope, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { actDelivery, openDirectedLedger } from './delivery.js';
import { addMember } from './members.js';
import { countOpenLoops, insertMessage, listInbox } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * ADR 434 — one discharge predicate, four readers, and the two shapes they did not all know.
 *
 * ryder answered a threaded steer IN THE THREAD (no `in_reply_to`) and was woken for it again
 * sixteen minutes later; gptbot answered an urgent steer by `message` with `in_reply_to`, twice,
 * and was leased for it three times and then declared exhausted. Each reader below spelled its
 * own discharge; these cases pin that they now agree, on both shapes, and that a third party's
 * chatter still discharges nothing.
 */
async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
  const bob = (await addMember(db, team, { name: 'bob', kind: 'agent' })).row;
  // These fixtures stamp messages with fake receipt times near zero. A seat is owed only what arrived
  // after it existed (ADR 549), so the members must predate them too.
  await db.run('UPDATE members SET created_at = 0 WHERE team_id = ?', [team.id]);
  return { db, team, nick, ada, bob };
}

async function msg(
  db: Database,
  team: TeamRow,
  from: MemberRow,
  to: MemberRow | null,
  act: Act,
  id: string,
  ts: number,
  opts: { thread?: string; meta?: Record<string, unknown> } = {},
) {
  await insertMessage(
    db,
    team.id,
    from.id,
    to?.id ?? null,
    makeEnvelope({
      id,
      team: team.slug,
      from: from.name,
      to: to ? { kind: 'member', name: to.name } : { kind: 'team' },
      act,
      body: 'x',
      thread: opts.thread ?? null,
      meta: opts.meta ?? null,
      ts,
    }),
    { now: ts },
  );
}

const pinnedIds = async (db: Database, m: MemberRow) =>
  (await listInbox(db, m, { unreadOnly: true, cursorTs: 0, limit: 1 })).map((r) => r.id);
const ledgerIds = async (db: Database, team: TeamRow) =>
  (await openDirectedLedger(db, team.id, 100_000)).map((d) => d.id);
const adaState = async (db: Database, team: TeamRow, id: string) =>
  (await actDelivery(db, team.id, id, 100_000))!.recipients.find((r) => r.seat === 'Ada')!.state;

withDrivers('discharge', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe("ADR 434: the recipient's in-thread reply discharges — ryder's shape", async () => {
    it('a threaded handoff answered by a plain message in its thread is discharged for every reader', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, null, 'message', 'root', 1_000);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_001, { thread: 'root' });
      for (let i = 0; i < 5; i++) await msg(db, team, nick, null, 'message', `n${i}`, 2_000 + i);
      expect(await pinnedIds(db, ada)).toContain('h1');
      expect(await ledgerIds(db, team)).toContain('h1');
      expect(await countOpenLoops(db)).toBe(1);
      expect(await adaState(db, team, 'h1')).toBe('logged');

      await msg(db, team, ada, null, 'message', 'reply', 3_000, { thread: 'root' });
      expect(await pinnedIds(db, ada)).not.toContain('h1');
      expect(await ledgerIds(db, team)).not.toContain('h1');
      expect(await countOpenLoops(db)).toBe(0);
      expect(await adaState(db, team, 'h1')).toBe('answered');
      expect(
        (await actDelivery(db, team.id, 'h1', 100_000))!.recipients[0]!.answered,
      ).toMatchObject({
        act: 'message',
        id: 'reply',
      });
    });

    it("a reply in the thread OLDER than the act is not an answer — ryder's earlier turn did not answer stanley's later steer", async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, null, 'message', 'root', 1_000);
      await msg(db, team, ada, null, 'message', 'earlier', 1_500, { thread: 'root' });
      await msg(db, team, nick, ada, 'handoff', 'h1', 2_000, { thread: 'root' });
      expect(await ledgerIds(db, team)).toContain('h1');
      expect(await adaState(db, team, 'h1')).toBe('logged');
    });

    it('an act that opens its own thread is answered by a reply threaded on its id', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      await msg(db, team, ada, null, 'status_update', 'r', 2_000, { thread: 'h1' });
      expect(await ledgerIds(db, team)).not.toContain('h1');
      expect(await adaState(db, team, 'h1')).toBe('answered');
    });
  });

  describe("ADR 434: the recipient's in_reply_to on ANY act discharges — gptbot's shape", async () => {
    it('an urgent directed act answered by a `message` carrying in_reply_to leaves the ledger', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'steer', 's1', 1_000, {
        meta: { urgent: true, urgent_reason: 'r' },
      });
      expect(await ledgerIds(db, team)).toContain('s1');
      await msg(db, team, ada, nick, 'message', 'standing-down', 2_000, {
        meta: { in_reply_to: 's1' },
      });
      expect(await ledgerIds(db, team)).not.toContain('s1');
      expect(await adaState(db, team, 's1')).toBe('answered');
    });
  });

  describe('ADR 623: an advisory channel reply discharges the wait, never the authority', async () => {
    it("the addressed human's channel reply (a `message` with in_reply_to) discharges a consult addressed to them", async () => {
      const { db, team, nick, ada } = await seed();
      const consult = { species: 'consult', tier: 'standard', action_class: 'advisory' };
      for (let i = 0; i < 5; i++) await msg(db, team, ada, null, 'message', `n${i}`, 1_100 + i);
      await msg(db, team, ada, nick, 'ask', 'ask-1', 1_000, { meta: consult });
      expect(await pinnedIds(db, nick)).toContain('ask-1');

      await msg(db, team, nick, ada, 'message', 'chan-reply', 2_000, {
        meta: {
          in_reply_to: 'ask-1',
          channel_answer: { channel: 'slack', assurance: 'A1', decision: 'approve' },
        },
      });
      // The agent stops waiting: it reads the reply as information (ADR 618 §4)...
      expect(await pinnedIds(db, nick)).not.toContain('ask-1');
      // ...and nothing else moved: it is a `message`, so the accept/decline readers do not see it.
      const answers = await db.all(
        "SELECT 1 FROM messages WHERE in_reply_to = ? AND act IN ('accept','decline')",
        ['ask-1'],
      );
      expect(answers).toHaveLength(0);
    });

    it('a channel reply from someone other than the addressed human discharges nothing', async () => {
      const { db, team, nick, ada, bob } = await seed();
      const consult = { species: 'consult', tier: 'standard', action_class: 'advisory' };
      for (let i = 0; i < 5; i++) await msg(db, team, ada, null, 'message', `n${i}`, 1_100 + i);
      await msg(db, team, ada, nick, 'ask', 'ask-1', 1_000, { meta: consult });
      await msg(db, team, bob, ada, 'message', 'not-the-human', 2_000, {
        meta: { in_reply_to: 'ask-1', channel_answer: { channel: 'slack', assurance: 'A1' } },
      });
      expect(await pinnedIds(db, nick)).toContain('ask-1');
    });
  });

  describe('ADR 434: what still does NOT discharge', async () => {
    it("a third party's message in the thread or naming the act is chatter, not an answer", async () => {
      const { db, team, nick, ada, bob } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000, { thread: 't' });
      await msg(db, team, bob, null, 'message', 'c1', 2_000, { thread: 't' });
      await msg(db, team, bob, nick, 'message', 'c2', 3_000, { meta: { in_reply_to: 'h1' } });
      expect(await pinnedIds(db, ada)).toContain('h1');
      expect(await ledgerIds(db, team)).toContain('h1');
      expect(await countOpenLoops(db)).toBe(1);
      expect(await adaState(db, team, 'h1')).toBe('logged');
    });

    it('a @team request_help is not discharged by one seat talking in its thread — ADR 254 needs an answer', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, null, 'request_help', 'r1', 1_000, { thread: 't' });
      await msg(db, team, ada, null, 'message', 'c1', 2_000, { thread: 't' });
      expect(await ledgerIds(db, team)).toContain('r1');
      expect(await countOpenLoops(db)).toBe(1);
      await msg(db, team, ada, nick, 'accept', 'a1', 3_000, { meta: { in_reply_to: 'r1' } });
      expect(await ledgerIds(db, team)).not.toContain('r1');
      expect(await countOpenLoops(db)).toBe(0);
    });
  });
});
