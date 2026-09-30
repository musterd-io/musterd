import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { rowsToEnvelopes } from './hydrate.js';
import { addMember } from './members.js';
import { insertMessage, listTeamMessages } from './messages.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * Turning message rows into Envelopes needs each row's sender and recipient NAME, and every call site
 * that did it walked the rows asking `getMemberById` one row at a time. A team has tens of members and
 * a window has thousands of rows, so that is thousands of statements to learn tens of names — measured
 * at 800 statements for 31 names on the revive team.
 *
 * It matters because of WHERE it runs. `/inbox/interrupt-check` is called by a PostToolUse hook at
 * every tool boundary of every live agent and is documented sub-50ms; the daemon is single-threaded
 * over synchronous better-sqlite3, so the time any handler holds is time `/health` waits, and the
 * guardian reports `daemon_down` when `/health` misses its timeout. Measured: with one seat 6000 acts
 * behind its cursor, `/health` p99 reached 205ms against a 100ms bar.
 *
 * So the property under test is not "it is fast" but the shape that makes it fast: cost is a function
 * of how many DISTINCT members appear, never of how many rows there are.
 */
async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
  return { db, team, nick, ada };
}

/** Counts the per-member lookup the old per-row hydration drove. */
async function countMemberLookups(db: Driver, run: () => void | Promise<void>): Promise<number> {
  let n = 0;
  const off = db.onStatement((sql) => {
    if (/FROM members WHERE id = \?/.test(sql)) n++;
  });
  try {
    await run();
  } finally {
    off();
  }
  return n;
}

withDrivers('hydrate', (o, kind) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('rowsToEnvelopes', async () => {
    // Counts statements through the SQLite driver's seam; the property itself is driver-neutral.
    it.runIf(kind === 'sqlite')(
      'asks each distinct member for its name once, not once per row',
      async () => {
        const { db, team, nick, ada } = await seed();
        for (let i = 0; i < 200; i++) {
          await insertMessage(
            db,
            team.id,
            i % 2 === 0 ? nick.id : ada.id,
            i % 2 === 0 ? ada.id : nick.id,
            makeEnvelope({
              id: `m${i}`,
              team: team.slug,
              from: i % 2 === 0 ? 'nick' : 'Ada',
              to: { kind: 'member', name: i % 2 === 0 ? 'Ada' : 'nick' },
              act: 'message',
              body: 'x',
              thread: null,
              meta: null,
              ts: 1_000 + i,
            }),
          );
        }
        const rows = await listTeamMessages(db, team.id, { limit: 500 });
        expect(rows).toHaveLength(200);

        let out: unknown[] = [];
        const lookups = await countMemberLookups(db, async () => {
          out = await rowsToEnvelopes(db, team.slug, rows);
        });

        expect(out).toHaveLength(200);
        // Two distinct members across 200 rows.
        expect(lookups).toBe(2);
      },
    );

    it('names the sender and recipient exactly as the per-row hydration did', async () => {
      const { db, team, nick, ada } = await seed();
      await insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 'directed',
          team: team.slug,
          from: 'nick',
          to: { kind: 'member', name: 'Ada' },
          act: 'message',
          body: 'x',
          thread: null,
          meta: null,
          ts: 1_000,
        }),
      );
      await insertMessage(
        db,
        team.id,
        ada.id,
        null,
        makeEnvelope({
          id: 'to-team',
          team: team.slug,
          from: 'Ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 'x',
          thread: null,
          meta: null,
          ts: 1_001,
        }),
      );

      const envelopes = await rowsToEnvelopes(
        db,
        team.slug,
        await listTeamMessages(db, team.id, { limit: 10 }),
      );
      const directed = envelopes.find((e) => e.id === 'directed')!;
      const toTeam = envelopes.find((e) => e.id === 'to-team')!;

      expect(directed.from).toBe('nick');
      expect(directed.to).toEqual({ kind: 'member', name: 'Ada' });
      expect(toTeam.from).toBe('Ada');
      expect(toTeam.to).toEqual({ kind: 'team' });
    });
  });
});
