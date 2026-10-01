import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import type { PgliteDriver } from '../db/pgliteDriver.js';
import type { SqliteDriver } from '../db/sqliteDriver.js';
import { withDrivers } from '../db/testing.js';
import { deferralFold } from './deferralFold.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('deferralFold', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * The deferral fold (ADR 211) answers two questions over a bounded window of the party-scoped
   * timeline: which acts has this seat postponed, and which of those have since been raised. Both the
   * inbox read and the wake poll need it, and both used to pay for it the same way — hydrate the whole
   * 2000-row window into Envelopes, then ask a question that reads only the seat's OWN `wait` acts.
   *
   * On the overwhelmingly common path nothing is deferred, so all of that was discarded. It is the
   * inbox route's dominant cost, and the inbox route is on the request path of a single-threaded daemon
   * whose `/health` probe the guardian treats as liveness — measured at 26ms per check with nothing
   * deferred, against a 100ms budget shared with everything else.
   *
   * So the property is: the window is hydrated only when a deferral is actually held, and when it is
   * held the answer is identical to hydrating it every time.
   */
  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
    return { db, team, nick, ada };
  }

  let ts = 1_000;
  async function say(
    db: Database,
    team: TeamRow,
    from: MemberRow,
    to: MemberRow | null,
    act: string,
    id: string,
    meta: Record<string, unknown> | null = null,
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
        act: act as 'message',
        body: 'x',
        thread: null,
        meta,
        ts: ts++,
      }),
    );
  }

  /** How many `members` lookups a run made — both drivers expose the statement seam. */
  async function countMemberLookups(db: Driver, run: () => void | Promise<void>): Promise<number> {
    let n = 0;
    const detach = (db as SqliteDriver | PgliteDriver).onStatement((sql) => {
      if (/FROM members WHERE id = \?/.test(sql)) n++;
    });
    try {
      await run();
    } finally {
      detach();
    }
    return n;
  }

  describe('deferralFold', async () => {
    it('holds nothing, and hydrates nothing, when the seat has deferred nothing', async () => {
      const { db, team, nick, ada } = await seed();
      for (let i = 0; i < 300; i++) await say(db, team, nick, null, 'status_update', `c${i}`);

      let out: ReturnType<typeof deferralFold> | undefined;
      const lookups = await countMemberLookups(db, async () => {
        out = await deferralFold(db, team.slug, ada);
      });

      expect(out!.held.size).toBe(0);
      expect(out!.raised.size).toBe(0);
      expect(lookups).toBe(0);
    });

    it('folds the seat’s own wait onto the act it postpones', async () => {
      const { db, team, nick, ada } = await seed();
      await say(db, team, nick, ada, 'message', 'a1');
      await say(db, team, ada, null, 'wait', 'w1', { defer_ref: 'a1', until: { lane: 'L1' } });

      const { held, raised } = await deferralFold(db, team.slug, ada);
      expect([...held.keys()]).toEqual(['a1']);
      expect(raised.size).toBe(0);
    });

    it('raises the deferral once the condition it named fires', async () => {
      const { db, team, nick, ada } = await seed();
      await say(db, team, nick, ada, 'message', 'a1');
      await say(db, team, ada, null, 'wait', 'w1', { defer_ref: 'a1', until: { lane: 'L1' } });
      await say(db, team, nick, null, 'message', 'l1', {
        lane_state: { lane: 'L1', state: 'done' },
      });

      const { held, raised } = await deferralFold(db, team.slug, ada);
      expect([...held.keys()]).toEqual(['a1']);
      expect([...raised]).toEqual(['a1']);
    });

    it('ignores a wait authored by someone else — only the recipient may defer', async () => {
      const { db, team, nick, ada } = await seed();
      await say(db, team, nick, ada, 'message', 'a1');
      await say(db, team, nick, null, 'wait', 'w1', { defer_ref: 'a1', until: { lane: 'L1' } });

      expect((await deferralFold(db, team.slug, ada)).held.size).toBe(0);
    });
  });
});
