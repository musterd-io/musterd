import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { buildDigest } from '../digest/digest.js';
import { buildDreamPacket } from './dream.js';
import { insightVerdicts } from './insightStatus.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { searchInsights } from './teamMemory.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('insightStatus', (o) => {
  /**
   * ADR 526 — the accept case is the 600-char clip: three seats each recorded a bug that #2066
   * then fixed, and search, every night's dream and the digest kept serving all three. A finding
   * can now be withdrawn by its author (or a human) and replaced, and the readers that re-broadcast
   * findings stop carrying the withdrawn ones. Nobody can bury someone else's.
   */
  beforeEach(() => {
    openStore = o;
  });

  const T0 = 1_791_000_000_000;

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'dawn' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const miley = (await addMember(db, team, { name: 'miley', kind: 'agent' })).row;
    const ghost = (await addMember(db, team, { name: 'ghost', kind: 'agent' })).row;
    return { db, team, nick, miley, ghost };
  }

  async function insight(
    db: Driver,
    team: TeamRow,
    from: MemberRow,
    headline: string,
    ts: number,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const id = ulid(ts);
    await insertMessage(
      db,
      team.id,
      from.id,
      null,
      makeEnvelope({
        id,
        team: team.slug,
        from: from.name,
        to: { kind: 'team' },
        act: 'insight',
        body: `${headline} — body`,
        meta: { headline, ...extra },
        ts,
      }),
      ts,
    );
    return id;
  }

  async function retract(db: Driver, team: TeamRow, from: MemberRow, id: string, ts: number) {
    await insertMessage(
      db,
      team.id,
      from.id,
      null,
      makeEnvelope({
        id: ulid(ts),
        team: team.slug,
        from: from.name,
        to: { kind: 'team' },
        act: 'resolve',
        thread: id,
        body: 'fixed by #2066',
        ts,
      }),
      ts,
    );
  }

  describe('insightVerdicts', () => {
    it("the author's resolve retracts; a human's does too; anyone else's is an ordinary resolve", async () => {
      const { db, team, nick, miley, ghost } = await seed();
      const a = await insight(db, team, miley, 'clip one', T0);
      const b = await insight(db, team, miley, 'clip two', T0 + 1);
      const c = await insight(db, team, miley, 'clip three', T0 + 2);
      await retract(db, team, miley, a, T0 + 10);
      await retract(db, team, nick, b, T0 + 11);
      await retract(db, team, ghost, c, T0 + 12);
      const v = await insightVerdicts(db, team.id, [
        { id: a, from_member: miley.id },
        { id: b, from_member: miley.id },
        { id: c, from_member: miley.id },
      ]);
      expect(v.get(a)).toMatchObject({ hidden: true, status: { retracted: { by: 'miley' } } });
      expect(v.get(b)).toMatchObject({ hidden: true, status: { retracted: { by: 'nick' } } });
      expect(v.get(c)).toEqual({ status: null, hidden: false });
    });

    it('supersession by the author hides; by another seat it only annotates', async () => {
      const { db, team, miley, ghost } = await seed();
      const old1 = await insight(db, team, miley, 'clip at 600', T0);
      const old2 = await insight(db, team, miley, 'clip again', T0 + 1);
      const mine = await insight(db, team, miley, 'clip fixed', T0 + 5, { supersedes: [old1] });
      await insight(db, team, ghost, 'actually fixed', T0 + 6, { supersedes: [old2] });
      const v = await insightVerdicts(db, team.id, [
        { id: old1, from_member: miley.id },
        { id: old2, from_member: miley.id },
      ]);
      expect(v.get(old1)).toMatchObject({
        hidden: true,
        status: { superseded_by: [{ id: mine, from: 'miley', hides: true }] },
      });
      expect(v.get(old2)).toMatchObject({
        hidden: false,
        status: { superseded_by: [{ from: 'ghost', headline: 'actually fixed', hides: false }] },
      });
    });
  });

  describe('the readers that re-broadcast findings', () => {
    it('search leaves out a retracted finding, keeps it under all=1, and annotates the rest', async () => {
      const { db, team, miley, ghost } = await seed();
      const gone = await insight(db, team, miley, 'packet clip trap', T0);
      const kept = await insight(db, team, miley, 'packet clip measured', T0 + 1);
      await retract(db, team, miley, gone, T0 + 10);
      await insight(db, team, ghost, 'packet clip resolved', T0 + 11, { supersedes: [kept] });

      const hits = await searchInsights(db, team.id, 'packet clip');
      expect(hits.map((h) => h.id)).not.toContain(gone);
      const keptHit = hits.find((h) => h.id === kept)!;
      expect(keptHit.status?.superseded_by?.[0]).toMatchObject({ from: 'ghost', hides: false });

      const all = await searchInsights(db, team.id, 'packet clip', 20, { includeRetracted: true });
      expect(all.find((h) => h.id === gone)?.status?.retracted?.by).toBe('miley');
    });

    it("tonight's dream packet does not re-read a retracted finding", async () => {
      const { db, team, miley, ghost } = await seed();
      const gone = await insight(db, team, miley, 'clip trap', T0);
      const stays = await insight(db, team, ghost, 'other finding', T0 + 1);
      await retract(db, team, miley, gone, T0 + 2);
      const { packet } = await buildDreamPacket(db, team, ghost, { since: T0 - 1, now: T0 + 100 });
      const ids = packet.learned.map((l) => l.id);
      expect(ids).toContain(stays);
      expect(ids).not.toContain(gone);
    });

    it("tomorrow's digest does not re-announce it", async () => {
      const { db, team, miley } = await seed();
      const gone = await insight(db, team, miley, 'clip trap', T0);
      await insight(db, team, miley, 'clip fixed', T0 + 1);
      await retract(db, team, miley, gone, T0 + 2);
      const digest = await buildDigest(db, team.id, {
        day: '2026-10-05',
        nightStart: T0 - 1,
        now: T0 + 100,
      });
      expect(digest.learned.map((l) => l.headline)).toEqual(['clip fixed']);
    });
  });
});
