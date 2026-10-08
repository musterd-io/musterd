import { makeEnvelope, type Act } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { getCursor, setCursor } from './cursors.js';
import { addMember } from './members.js';
import { insertMessage, listInbox } from './messages.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * Lane 01M4E4N1J3 / ADR 549. alfie, a seat created on 2026-10-08, opened its inbox to 14,097 unread
 * and the same twelve old team-wide acts at the top of every check. A seat that has never read had
 * cursor 0, so everything the team ever sent counted as unread, and the pinned obligations (asks and
 * requests for help to @team that nobody discharged) ride the same cursor floor, so every one of them
 * was "owed" by a seat that did not exist when it was sent.
 */

/** Real-clock time at which the new seat is created; every "before" message is stamped earlier. */
async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  let n = 0;
  const toTeam = async (act: Act, now: number, id = `m${String(n++).padStart(3, '0')}`) => {
    const required: Partial<Record<Act, Record<string, unknown>>> = {
      ask: { species: 'consult', tier: 'standard' },
    };
    await insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id,
        team: team.slug,
        from: 'nick',
        to: { kind: 'team' },
        act,
        body: 'x',
        meta: required[act] ?? {},
        ts: now,
      }),
      { now },
    );
    return id;
  };
  return { db, team, nick, toTeam };
}

/** What `GET /inbox` hands the list: the cursor the server holds, as the route reads it. */
async function unreadFor(db: Driver, seat: { id: string; team_id: string }, limit?: number) {
  const cursor = await getCursor(db, seat.id);
  return (
    await listInbox(db, seat, {
      unreadOnly: true,
      cursorTs: cursor.last_read_ts,
      ...(cursor.last_read_message_id ? { cursorId: cursor.last_read_message_id } : {}),
      ...(limit !== undefined ? { limit } : {}),
    })
  ).map((r) => r.id);
}

withDrivers('inboxNewSeat', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  describe('ADR 549: a seat is owed only what arrived after it existed', async () => {
    it('a seat that has never read does not inherit the team history, nor its unanswered team-wide asks', async () => {
      const { db, team, toTeam } = await seed();
      const longAgo = Date.now() - 86_400_000;
      const oldAsk = await toTeam('ask', longAgo);
      const oldHelp = await toTeam('request_help', longAgo + 1);
      const oldChatter = await toTeam('message', longAgo + 2);

      const alfie = (await addMember(db, team, { name: 'alfie', kind: 'agent' })).row;

      for (const limit of [undefined, 50]) {
        const rows = await unreadFor(db, alfie, limit);
        expect(rows).not.toContain(oldAsk);
        expect(rows).not.toContain(oldHelp);
        expect(rows).not.toContain(oldChatter);
      }
    });

    it('still sees everything that arrives after it exists — asks pinned, broadcasts in the tail', async () => {
      const { db, team, toTeam } = await seed();
      const alfie = (await addMember(db, team, { name: 'alfie', kind: 'agent' })).row;
      const born = (await db.get<{ created_at: number }>(
        'SELECT created_at FROM members WHERE id = ?',
        [alfie.id],
      ))!.created_at;

      const ask = await toTeam('ask', born + 10);
      const chatter = await toTeam('message', born + 11);
      for (const limit of [undefined, 50]) {
        const rows = await unreadFor(db, alfie, limit);
        expect(rows).toContain(ask);
        expect(rows).toContain(chatter);
      }
    });

    it('counts an act in the same millisecond the seat was created — the welcome notice must not vanish', async () => {
      const { db, team, toTeam } = await seed();
      const alfie = (await addMember(db, team, { name: 'alfie', kind: 'agent' })).row;
      const born = (await db.get<{ created_at: number }>(
        'SELECT created_at FROM members WHERE id = ?',
        [alfie.id],
      ))!.created_at;
      const sameMs = await toTeam('message', born);
      expect(await unreadFor(db, alfie)).toContain(sameMs);
    });

    it('leaves a seat that HAS read exactly where its cursor says — the floor is only for "never"', async () => {
      const { db, team, toTeam } = await seed();
      const longAgo = Date.now() - 86_400_000;
      const first = await toTeam('message', longAgo);
      const second = await toTeam('message', longAgo + 1);
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      await setCursor(db, ada.id, first);
      // An explicit cursor wins, even though `second` pre-dates the seat's creation.
      expect(await unreadFor(db, ada)).toEqual([second]);
    });
  });
});
