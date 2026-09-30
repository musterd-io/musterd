import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { getCursor, setCursor } from './cursors.js';
import { actDelivery, crossedBySeen } from './delivery.js';
import { listInterruptCandidates } from './interruptCandidates.js';
import { addMember } from './members.js';
import { countUnread, insertMessage, listInbox } from './messages.js';
import { slowestInboxLagMs } from './metrics.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * The ts-cursor defect (federation 3b-ii finding, lane 01M1FAYTHQA881M35PDPXRTGM1).
 *
 * `messages.ts` is the ORIGIN's clock: the sender's process stamps it (`makeEnvelope` defaults it to
 * `Date.now()` on the client), and ADR 335 has it travel unchanged through the sync log. A read
 * cursor keyed on it therefore compares a seat's progress against a clock this daemon does not
 * control. An event that arrives AFTER the seat last read, carrying a `ts` from BEFORE it — a folded
 * remote event behind ordinary sync lag, or a local sender with a skewed clock — is not "shown late":
 * it is never shown, because the cursor only moves forward.
 *
 * The falsifier the spec wrote before any reader moved: fold an event whose `ts` is one hour below
 * a seat's cursor and assert every reader still surfaces it. Red on ts-keyed readers, green only
 * when all of them key on `created_at` — this daemon's receipt clock, which is monotone here by
 * construction (insertMessage and foldBatch both stamp it with the local `now`).
 */
async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
  // Receipt clock advances by one per send, whatever ts the envelope carries — a fold behind sync
  // lag looks exactly like this: arrives now, stamped then.
  let clock = Date.now();
  const send = async (id: string, ts: number, meta: Record<string, unknown> | null = null) =>
    await insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id,
        team: team.slug,
        from: 'nick',
        to: { kind: 'member', name: 'Ada' },
        act: 'message',
        body: 'x',
        thread: null,
        meta,
        ts,
      }),
      { now: ++clock },
    );
  return { db, team, nick, ada, send };
}

const HOUR = 3_600_000;

withDrivers('cursorReceiptOrder', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('a late-arriving event with an old ts is still unread (receipt-order cursor)', async () => {
    it('listInbox unreadOnly returns it, after the row the seat already read', async () => {
      const { db, ada, send } = await seed();
      const now = Date.now();
      const read = await send('m-read', now);
      await setCursor(db, ada.id, read.id);
      const late = await send('m-late', now - HOUR);

      const unread = await listInbox(db, ada, {
        unreadOnly: true,
        cursorTs: (await getCursor(db, ada.id)).last_read_ts,
        cursorId: (await getCursor(db, ada.id)).last_read_message_id,
      });
      expect(unread.map((r) => r.id)).toEqual([late.id]);
      // Receipt order, not origin order: the whole inbox lists the late arrival LAST even though its
      // ts is an hour older, because that is the order the cursor walks.
      expect((await listInbox(db, ada)).map((r) => r.id)).toEqual([read.id, late.id]);
    });

    it('countUnread agrees with the listing', async () => {
      const { db, ada, send } = await seed();
      const now = Date.now();
      await setCursor(db, ada.id, (await send('m-read', now)).id);
      await send('m-late', now - HOUR);
      const c = await getCursor(db, ada.id);
      expect(await countUnread(db, ada, c.last_read_ts, c.last_read_message_id)).toBe(1);
    });

    it('the interrupt window sees an urgent late arrival', async () => {
      const { db, ada, send } = await seed();
      const now = Date.now();
      await setCursor(db, ada.id, (await send('m-read', now)).id);
      const late = await send('m-late', now - HOUR, { urgent: true, urgent_reason: 'steer' });
      const rows = await listInterruptCandidates(db, ada, {
        cursorTs: (await getCursor(db, ada.id)).last_read_ts,
      });
      expect(rows.map((r) => r.id)).toEqual([late.id]);
    });

    it('the delivery ledger calls it logged, not seen', async () => {
      const { db, team, ada, send } = await seed();
      const now = Date.now();
      await setCursor(db, ada.id, (await send('m-read', now)).id);
      const late = await send('m-late', now - HOUR);
      const ledger = (await actDelivery(db, team.id, late.id))!;
      expect(ledger.recipients.find((r) => r.seat === 'Ada')?.state).toBe('logged');
    });

    it('the backlog gauge is non-zero while it waits', async () => {
      const { db, ada, send } = await seed();
      const now = Date.now();
      await setCursor(db, ada.id, (await send('m-read', now)).id);
      await send('m-late', now - HOUR);
      expect(await slowestInboxLagMs(db, now + 10_000)).toBeGreaterThan(0);
    });

    it('advancing the cursor over it counts it as newly seen', async () => {
      const { db, team, ada, send } = await seed();
      const now = Date.now();
      await setCursor(db, ada.id, (await send('m-read', now)).id);
      const late = await send('m-late', now - HOUR);
      const prev = await getCursor(db, ada.id);
      const next = await setCursor(db, ada.id, late.id);
      const crossed = await crossedBySeen(
        db,
        team.id,
        ada.id,
        prev.last_read_ts,
        next.last_read_ts,
      );
      expect(crossed.map((c) => c.ts)).toEqual([late.ts]);
    });

    it('the cursor row is stamped with the receipt clock, not the envelope ts', async () => {
      const { db, ada, send } = await seed();
      const row = await send('m-old', Date.now() - HOUR);
      const cursor = await setCursor(db, ada.id, row.id);
      expect(cursor.last_read_ts).toBe(row.created_at);
      expect(cursor.last_read_ts).not.toBe(row.ts);
    });

    it('refuses to point the cursor at a message that does not exist', async () => {
      const { db, ada } = await seed();
      await expect(setCursor(db, ada.id, 'nope')).rejects.toThrow();
    });
  });
});
