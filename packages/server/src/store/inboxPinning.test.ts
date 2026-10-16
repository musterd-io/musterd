import { isObligationAct, makeEnvelope, type Act } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { openLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage, listInbox, PINNED_DEFAULT_LIMIT } from './messages.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * ADR 429 — the pinned set is the OBLIGATION class, bounded, and folded for discharge in SQL.
 *
 * A bounded page unions a pinned set on top of the newest tail so an act that is WAITING on the
 * reader cannot fall off the bottom. Before this ADR the pin predicate was `to_kind = 'member' AND
 * act NOT IN ('message','resolve')` with no LIMIT, which is a salience test doing a retention job:
 * it pinned every unread `accept`, `decline` and directed `status_update` forever, and `limit` did
 * not bound the reply at all. Measured on the laptop daemon 2026-09-21 — 370 pinned rows / 327 KB
 * for one seat at `limit: 8`, 183 of those rows answers and reports owed to nobody.
 *
 * Nothing in the suite covered any of it: this whole file is the hole that let it land.
 */

let seq = 0;
async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
  const bo = (await addMember(db, team, { name: 'Bo', kind: 'agent' })).row;
  seq = 0;
  const send = async (
    act: Act,
    opts: {
      to?: 'Ada' | 'team';
      from?: { id: string; name: string };
      meta?: Record<string, unknown>;
      id?: string;
      thread?: string;
    } = {},
  ) => {
    const from = opts.from ?? { id: nick.id, name: 'nick' };
    const id = opts.id ?? `m${String(seq).padStart(3, '0')}`;
    const toAda = (opts.to ?? 'Ada') === 'Ada';
    // The act-meta rules the envelope schema enforces (SPEC A.6). Only what each act REQUIRES —
    // a fixture that argued with the schema here would be testing the wrong thing.
    const required: Partial<Record<Act, Record<string, unknown>>> = {
      ask: { species: 'consult', tier: 'standard' },
      defer: { goal_id: 'g1' },
      insight: { headline: 'h' },
      accept: { in_reply_to: 'x' },
      decline: { in_reply_to: 'x' },
    };
    await insertMessage(
      db,
      team.id,
      from.id,
      toAda ? ada.id : null,
      makeEnvelope({
        id,
        team: team.slug,
        from: from.name,
        to: toAda ? { kind: 'member', name: 'Ada' } : { kind: 'team' },
        act,
        body: 'x',
        thread: opts.thread ?? null,
        meta: { ...(required[act] ?? {}), ...(opts.meta ?? {}) },
        ts: 1_000 + seq,
      }),
      { now: 1_000 + seq },
    );
    seq += 1;
    return id;
  };
  return { db, team, ada, nick, bo, send };
}

/** The bounded read every agent surface makes: a named `limit`, unread only, from the origin. */
const bounded = async (
  db: ReturnType<typeof seed>['db'],
  ada: { id: string; team_id: string },
  limit = 1,
) => (await listInbox(db, ada, { unreadOnly: true, cursorTs: 0, limit })).map((r) => r.id);

withDrivers('inboxPinning', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('ADR 429: pinning is an obligation rule', async () => {
    it('pins an ask and a request_help past the limit — the retention rule still holds', async () => {
      const { db, ada, send } = await seed();
      const ask = await send('ask');
      const help = await send('request_help', { to: 'team' });
      for (let i = 0; i < 20; i++) await send('message');
      const rows = await bounded(db, ada);
      expect(rows).toContain(ask);
      expect(rows).toContain(help);
    });

    it('pins a decline the daemon stamped as a review dispute — and not a plain one (ADR 505)', async () => {
      const { db, ada, send } = await seed();
      const rejection = await send('decline', {
        meta: { in_reply_to: 'ask-1', dispute: { via: 'review', lane: 'L1', ask: 'ask-1' } },
      });
      const plain = await send('decline', { meta: { in_reply_to: 'h-1' } });
      for (let i = 0; i < 20; i++) await send('message');
      const rows = await bounded(db, ada);
      expect(rows).toContain(rejection);
      expect(rows).not.toContain(plain);
    });

    it('ADR 614: a review dispute stays pinned through the owner\u2019s message; an accept or decline clears it', async () => {
      const { db, ada, send } = await seed();
      const stamp = (n: string) => ({
        in_reply_to: `ask-${n}`,
        dispute: { via: 'review', lane: `L${n}`, ask: `ask-${n}` },
      });
      const messaged = await send('decline', { meta: stamp('1') });
      const conceded = await send('decline', { meta: stamp('2') });
      const plainSteer = await send('steer');
      const ownerAda = { id: ada.id, name: 'Ada' };
      // The owner replies to the first with a message ("you're right"), to the second with accept.
      await send('message', { to: 'team', from: ownerAda, meta: { in_reply_to: messaged } });
      await send('accept', { to: 'team', from: ownerAda, meta: { in_reply_to: conceded } });
      // A message reply still discharges every other obligation (ADR 434 shape 3).
      await send('message', { to: 'team', from: ownerAda, meta: { in_reply_to: plainSteer } });
      for (let i = 0; i < 20; i++) await send('message');
      const rows = await bounded(db, ada);
      expect(rows).toContain(messaged);
      expect(rows).not.toContain(conceded);
      expect(rows).not.toContain(plainSteer);
    });

    it('pins the directed steering trio and a handoff', async () => {
      const { db, ada, send } = await seed();
      const owed: string[] = [];
      for (const a of ['handoff', 'steer', 'challenge', 'defer'] as const) owed.push(await send(a));
      for (let i = 0; i < 20; i++) await send('message');
      const rows = await bounded(db, ada);
      for (const id of owed) expect(rows).toContain(id);
    });

    it('does NOT pin an answer or a report — accept/decline/status_update/wait/insight', async () => {
      const { db, ada, send } = await seed();
      // The exact acts that made up 183 of one seat's 370 pinned rows.
      const notOwed: string[] = [];
      for (const a of ['accept', 'decline', 'status_update', 'wait', 'insight'] as const)
        notOwed.push(await send(a));
      for (let i = 0; i < 20; i++) await send('message');
      const rows = await bounded(db, ada);
      for (const id of notOwed) expect(rows).not.toContain(id);
      // Still UNREAD, not lost: an unbounded read returns every one of them.
      const all = (await listInbox(db, ada, { unreadOnly: true, cursorTs: 0 })).map((r) => r.id);
      for (const id of notOwed) expect(all).toContain(id);
    });

    it('bounds the pinned set, so `limit` finally bounds the reply', async () => {
      const { db, ada, send } = await seed();
      for (let i = 0; i < PINNED_DEFAULT_LIMIT + 25; i++) await send('ask');
      const rows = await listInbox(db, ada, { unreadOnly: true, cursorTs: 0, limit: 1 });
      // The pinned union plus the newest-tail — never the whole unread pile.
      expect(rows.length).toBeLessThanOrEqual(PINNED_DEFAULT_LIMIT + 1);
      const explicit = await listInbox(db, ada, {
        unreadOnly: true,
        cursorTs: 0,
        limit: 1,
        pinnedLimit: 5,
      });
      expect(explicit.length).toBeLessThanOrEqual(6);
    });

    it('keeps the OLDEST obligations when it bounds — the longest wait is the one not to drop', async () => {
      const { db, ada, send } = await seed();
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push(await send('ask'));
      const rows = (
        await listInbox(db, ada, {
          unreadOnly: true,
          cursorTs: 0,
          limit: 1,
          pinnedLimit: 3,
        })
      ).map((r) => r.id);
      for (const id of ids.slice(0, 3)) expect(rows).toContain(id);
    });
  });

  describe('ADR 429: discharge is folded before marshalling', async () => {
    it('drops an obligation any seat has accepted (ADR 254: first answer discharges the set)', async () => {
      const { db, ada, bo, send } = await seed();
      const ask = await send('ask', { id: 'the-ask' });
      // Bo answers, not Ada — a second eligible seat is not a party to the reply and could never fold
      // this client-side, which is exactly why the server owes it.
      await send('accept', {
        from: { id: bo.id, name: 'Bo' },
        to: 'team',
        meta: { in_reply_to: ask },
      });
      for (let i = 0; i < 20; i++) await send('message');
      expect(await bounded(db, ada)).not.toContain(ask);
    });

    it('drops an obligation this member has already replied to, whatever act the reply rode', async () => {
      const { db, ada, send } = await seed();
      const steer = await send('steer', { id: 'the-steer' });
      // Clause 7(iv): a steer has no accept/decline — the addressee's reply IS the answer.
      await send('status_update', {
        from: { id: ada.id, name: 'Ada' },
        to: 'team',
        meta: { in_reply_to: steer },
      });
      for (let i = 0; i < 20; i++) await send('message');
      expect(await bounded(db, ada)).not.toContain(steer);
    });

    it('keeps an obligation a THIRD party merely commented on', async () => {
      const { db, ada, bo, send } = await seed();
      const ask = await send('ask', { id: 'still-owed' });
      // A `message` is not an answer, whoever sent it.
      await send('message', {
        from: { id: bo.id, name: 'Bo' },
        to: 'team',
        meta: { in_reply_to: ask },
      });
      for (let i = 0; i < 20; i++) await send('message');
      expect(await bounded(db, ada)).toContain(ask);
    });

    it('does not match a row against itself — the correlated subquery names the outer table', async () => {
      const { db, ada, send } = await seed();
      // An `accept` whose own id is somehow its in_reply_to would self-discharge under an unqualified
      // `id` inside the EXISTS. The obligation here has no reply at all and must survive.
      const ask = await send('ask', { id: 'lonely' });
      for (let i = 0; i < 20; i++) await send('message');
      expect(await bounded(db, ada)).toContain(ask);
    });
  });

  describe("lane 01M4YYQCAP: a lane's own lifecycle discharges the acts that asked about it", async () => {
    const lane = async (db: Driver, state: string) => {
      const l = await openLane(
        db,
        (await db.get<{ id: string }>('SELECT id FROM teams'))!.id,
        'revive',
        'nick',
        {
          title: 'x',
        },
      );
      await db.run('UPDATE lanes SET state = ? WHERE id = ?', [state, l.id]);
      return l.id;
    };
    const pad = async (send: Awaited<ReturnType<typeof seed>>['send']) => {
      for (let i = 0; i < 20; i++) await send('message');
    };

    it('drops an acceptance ask whose lane has left awaiting_acceptance', async () => {
      const { db, ada, send } = await seed();
      const done = await lane(db, 'done');
      const ask = await send('ask', { id: 'closed-ask', meta: { lane_review: { lane: done } } });
      await pad(send);
      expect(await bounded(db, ada)).not.toContain(ask);
    });

    it('keeps an acceptance ask whose lane is still awaiting acceptance, or unknown', async () => {
      const { db, ada, send } = await seed();
      const open = await lane(db, 'awaiting_acceptance');
      const live = await send('ask', { id: 'live-ask', meta: { lane_review: { lane: open } } });
      const ghost = await send('ask', { id: 'ghost-ask', meta: { lane_review: { lane: 'nope' } } });
      await pad(send);
      const got = await bounded(db, ada, 2);
      expect(got).toContain(live);
      expect(got).toContain(ghost);
    });

    it('drops a handoff whose named lane is out of play, keeps one whose lane is active', async () => {
      const { db, ada, send } = await seed();
      const shipped = await lane(db, 'awaiting_acceptance');
      const active = await lane(db, 'claimed');
      const settled = await send('handoff', {
        id: 'settled',
        meta: { lane_handoff: { lane: shipped } },
      });
      const owed = await send('handoff', { id: 'owed', meta: { lane_handoff: { lane: active } } });
      await pad(send);
      const got = await bounded(db, ada, 2);
      expect(got).not.toContain(settled);
      expect(got).toContain(owed);
    });
  });

  describe('isObligationAct — the one list both readers are built from', () => {
    it('admits the any-recipient obligations whatever they are addressed to', () => {
      for (const act of ['request_help', 'ask'] as const) {
        expect(isObligationAct(act, true)).toBe(true);
        expect(isObligationAct(act, false)).toBe(true);
      }
    });

    it('admits the directed obligations only when directed', () => {
      for (const act of ['handoff', 'steer', 'challenge', 'defer'] as const) {
        expect(isObligationAct(act, true)).toBe(true);
        expect(isObligationAct(act, false)).toBe(false);
      }
    });

    it('refuses every answer, report and terminal act', () => {
      for (const act of [
        'accept',
        'decline',
        'wait',
        'resolve',
        'status_update',
        'message',
        'insight',
      ] as const) {
        expect(isObligationAct(act, true)).toBe(false);
        expect(isObligationAct(act, false)).toBe(false);
      }
    });
  });

  describe('ADR 432: a resolve on the thread discharges the obligation', async () => {
    it('drops an obligation whose thread carries a resolve — the gap ADR 429 shipped with', async () => {
      // `countOpenLoops` has honoured thread-resolve since ADR 090 and the CLI's `openActionNeeded`
      // always has; ADR 429's pinned fold did not. So a resolved obligation was excluded from the
      // open-loops gauge and from the human's banner while STILL being pinned into every bounded
      // agent read — three readers, two agreeing and the newest one not.
      const { db, ada, send } = await seed();
      const help = await send('request_help', { to: 'team', id: 'the-help' });
      await send('resolve', { to: 'team', thread: 'the-help' });
      for (let i = 0; i < 20; i++) await send('message');
      expect(await bounded(db, ada)).not.toContain(help);
    });

    it('is how a SERVICE seat discharges its own raise — guardian cannot accept (ADR 232)', async () => {
      // The shape ADR 432 relies on: guardian raises an `ask`, the condition clears, and guardian
      // closes the thread itself. Nothing accepts, because nothing may.
      const { db, ada, bo, send } = await seed();
      const incident = await send('ask', {
        to: 'team',
        id: 'daemon-down',
        from: { id: bo.id, name: 'Bo' },
      });
      for (let i = 0; i < 20; i++) await send('message');
      expect(await bounded(db, ada)).toContain(incident);

      const { db: db2, ada: ada2, bo: bo2, send: send2 } = await seed();
      const inc2 = await send2('ask', {
        to: 'team',
        id: 'daemon-down',
        from: { id: bo2.id, name: 'Bo' },
      });
      await send2('resolve', {
        to: 'team',
        thread: 'daemon-down',
        from: { id: bo2.id, name: 'Bo' },
      });
      for (let i = 0; i < 20; i++) await send2('message');
      expect(await bounded(db2, ada2)).not.toContain(inc2);
    });

    it('keeps an obligation whose thread carries a resolve for a DIFFERENT thread', async () => {
      const { db, ada, send } = await seed();
      const help = await send('request_help', { to: 'team', id: 'still-open' });
      await send('request_help', { to: 'team', id: 'other' });
      await send('resolve', { to: 'team', thread: 'other' });
      for (let i = 0; i < 20; i++) await send('message');
      expect(await bounded(db, ada)).toContain(help);
    });
  });
});
