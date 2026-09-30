import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { sqliteDriver } from '../db/sqliteDriver.js';
import { openTestDb } from '../db/testing.js';
import { setCursor } from './cursors.js';
import { addMember } from './members.js';
import { countOpenLoops, countOpenLoopsByTeam, getMessageTs, insertMessage } from './messages.js';
import { activePresenceBySurface, slowestInboxLagMs } from './metrics.js';
import { attach } from './presence.js';
import { createTeam } from './teams.js';

const TIMEOUT = 45_000;

async function seed() {
  const db = openTestDb(':memory:');
  const team = await createTeam(db, { slug: 'dawn' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
  return { db, team, nick, ada };
}

describe('activePresenceBySurface', async () => {
  it('counts live presences grouped by surface, ignoring stale + held rows', async () => {
    const { db, nick, ada } = await seed();
    await attach(db, nick.id, 'cli', 'c1');
    await attach(db, ada.id, 'claude-code', 'c2');
    // A held (released) presence and a stale one must not count.
    const held = await attach(db, ada.id, 'cursor', 'c3');
    db.prepare('UPDATE presence SET held_until = ? WHERE id = ?').run(Date.now() + 10_000, held.id);
    const stale = await attach(db, nick.id, 'web', 'c4');
    db.prepare('UPDATE presence SET last_seen_at = ? WHERE id = ?').run(
      Date.now() - TIMEOUT - 1,
      stale.id,
    );

    const rows = await activePresenceBySurface(sqliteDriver(db), TIMEOUT);
    const bySurface = Object.fromEntries(rows.map((r) => [r.surface, r.count]));
    expect(bySurface).toEqual({ cli: 1, 'claude-code': 1 });
  });
});

describe('slowestInboxLagMs', async () => {
  it('is 0 when nobody has unread messages', async () => {
    const { db } = await seed();
    expect(await slowestInboxLagMs(sqliteDriver(db))).toBe(0);
  });

  it('returns the age of the oldest unread message addressed to a member', async () => {
    const { db, team, nick, ada } = await seed();
    const now = 1_000_000;
    // nick sends a team message at t=now-30s → unread for Ada (and not for nick, the sender).
    await insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'm1',
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'request_help',
        body: 'help',
        ts: now - 30_000,
      }),
      { now: now - 30_000 },
    );
    expect(await slowestInboxLagMs(sqliteDriver(db), now)).toBe(30_000);

    // After Ada advances her cursor past it, the inbox is caught up → lag 0.
    await setCursor(db, ada.id, 'm1');
    expect(await slowestInboxLagMs(sqliteDriver(db), now)).toBe(0);
  });

  /**
   * Same root cause as ADR 290's amendment, in the backlog gauge: the unread clause compared on ts
   * alone, so a message sharing the cursor row's millisecond fell out of the join. The gauge then
   * reports a caught-up inbox — 0, the "nothing to see" value — while a message waits. An absence
   * claim from an instrument nobody re-derives is the worst shape for this to take.
   */
  it('counts a message tied with the cursor row — not caught up while one waits', async () => {
    const { db, team, nick, ada } = await seed();
    const now = 1_000_000;
    for (const id of ['m1', 'm2']) {
      await insertMessage(
        db,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'team' },
          act: 'request_help',
          body: 'help',
          ts: now - 30_000, // both in the same millisecond
        }),
        { now: now - 30_000 },
      );
    }
    // Ada reads m1 only. m2 shares its ts and is still waiting.
    await setCursor(db, ada.id, 'm1');
    expect(await slowestInboxLagMs(sqliteDriver(db), now)).toBe(30_000);
  });
});

describe('countOpenLoops / getMessageTs (ADR 082 slice 3)', async () => {
  it('counts directed acts without an answering accept/decline; getMessageTs resolves ts', async () => {
    const { db, team, nick, ada } = await seed();
    const send = async (
      id: string,
      from: string,
      fromId: string,
      act: 'request_help' | 'handoff' | 'accept' | 'status_update',
      meta?: Record<string, unknown>,
    ) =>
      await insertMessage(
        db,
        team.id,
        fromId,
        null,
        makeEnvelope({
          id,
          team: 'dawn',
          from,
          to: { kind: 'team' },
          act,
          body: 'x',
          meta: meta ?? null,
          ts: 500,
        }),
      );

    await send('r1', 'nick', nick.id, 'request_help');
    await send('h1', 'nick', nick.id, 'handoff');
    await send('s1', 'Ada', ada.id, 'status_update'); // not a loop
    expect(await countOpenLoops(db)).toBe(2);

    // Ada accepts the request → one loop closes; the handoff stays open.
    await send('a1', 'Ada', ada.id, 'accept', { in_reply_to: 'r1' });
    expect(await countOpenLoops(db)).toBe(1);

    // #207: the same count, grouped by team slug for the per-team open_loops gauge.
    expect(await countOpenLoopsByTeam(db)).toEqual([{ team: 'dawn', count: 1 }]);

    expect(await getMessageTs(db, team.id, 'r1')).toBe(500);
    expect(await getMessageTs(db, team.id, 'nope')).toBeNull();
  });
});
