import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { getCursor, setCursor } from './cursors.js';
import { actDelivery, crossedBySeen } from './delivery.js';
import { listInterruptCandidates } from './interruptCandidates.js';
import { addMember } from './members.js';
import { countUnread, insertMessage, listInbox, skipStaleUnowed } from './messages.js';
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

// ADR 811 (lane 01M6M95275): a deep backlog of rows nobody owed the reader is skipped as a count.
withDrivers('skipStaleUnowed (ADR 811)', (o) => {
  beforeEach(() => {
    openStore = o;
  });
  const DAY = 24 * 60 * 60 * 1000;

  async function stage() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
    const now = Date.now();
    const at = async (
      id: string,
      ageDays: number,
      act: string,
      to: { kind: 'team' } | { kind: 'member'; name: string },
      meta: Record<string, unknown> | null = null,
    ) =>
      await insertMessage(
        db,
        team.id,
        ada.id,
        to.kind === 'member' ? nick.id : null,
        makeEnvelope({
          id,
          team: 'revive',
          from: 'Ada',
          to,
          act: act as 'message',
          body: id,
          ts: now - ageDays * DAY,
          ...(meta ? { meta } : {}),
        }),
        { now: now - ageDays * DAY },
      );
    return { db, team, nick, now, at };
  }

  it('jumps over stale unowed rows up to the oldest directed or owed row, and counts them', async () => {
    const { db, team, nick, now, at } = await stage();
    await at('s-40', 40, 'status_update', { kind: 'team' });
    await at(
      'l-30',
      30,
      'message',
      { kind: 'team' },
      { lane_state: { lane: 'L1', state: 'done' } },
    );
    await at('m-20', 20, 'message', { kind: 'team' }); // a person's team message: unowed, stale
    await at('ask-10', 10, 'ask', { kind: 'team' }, { species: 'approve', tier: 'standard' }); // owed to the room: the stop
    await at('s-9', 9, 'status_update', { kind: 'team' });
    await at('s-1', 1, 'status_update', { kind: 'team' }); // fresh: never skipped
    // A seat is owed what arrived after it existed (ADR 549): the fixture backdates rows past the
    // member's birth, so it hands the skip the floor a long-lived seat would have.
    const floor = { last_read_ts: 0, last_read_message_id: null };
    const skip = await skipStaleUnowed(db, nick, floor, { now });
    expect(skip).not.toBeNull();
    expect(skip!.to.id).toBe('m-20');
    expect(skip!.skipped).toBe(3);
    expect(skip!.stopped_at?.id).toBe('ask-10');
    // Advanced there, the unread that remain are the stop and everything after it.
    await setCursor(db, nick.id, skip!.to.id);
    const left = await listInbox(db, nick, {
      unreadOnly: true,
      cursorTs: skip!.to.created_at,
      cursorId: skip!.to.id,
    });
    expect(left.map((r) => r.id)).toEqual(['ask-10', 's-9', 's-1']);
    // Nothing stale and unowed is left before the stop: a second skip is a no-op.
    expect(await skipStaleUnowed(db, nick, await getCursor(db, nick.id), { now })).toBeNull();
    void team;
  });

  it('a directed row stops the jump whatever its age', async () => {
    const { db, nick, now, at } = await stage();
    await at('dm-60', 60, 'message', { kind: 'member', name: 'nick' });
    await at('s-50', 50, 'status_update', { kind: 'team' });
    const floor = { last_read_ts: 0, last_read_message_id: null };
    expect(await skipStaleUnowed(db, nick, floor, { now })).toBeNull();
  });

  it('nothing within the window is skipped; past it, up to the newest stale row', async () => {
    const { db, nick, now, at } = await stage();
    await at('s-3', 3, 'status_update', { kind: 'team' });
    await at('s-2', 2, 'status_update', { kind: 'team' });
    const floor = { last_read_ts: 0, last_read_message_id: null };
    expect(await skipStaleUnowed(db, nick, floor, { now })).toBeNull();
    const wide = await skipStaleUnowed(db, nick, floor, { now, olderThanMs: DAY });
    expect(wide?.to.id).toBe('s-2');
    expect(wide?.skipped).toBe(2);
    expect(wide?.stopped_at).toBeNull();
  });
});
