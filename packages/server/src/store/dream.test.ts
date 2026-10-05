import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { buildDreamPacket, DREAM_BUDGET, dreamMayWrite } from './dream.js';
import { openLane } from './lanes.js';
import { addMember } from './members.js';
import { saveMemory } from './memory.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 10 * DAY;

withDrivers('dream', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const ryder = (await addMember(db, team, { name: 'ryder', kind: 'agent' })).row;
    const izzo = (await addMember(db, team, { name: 'izzo', kind: 'agent' })).row;
    return { db, team, ryder, izzo };
  }

  let n = 0;
  async function say(
    db: Driver,
    team: TeamRow,
    from: MemberRow,
    act: string,
    body: string,
    ts: number,
    meta: Record<string, unknown> | null = null,
  ) {
    const id = `01DREAM${String(n++).padStart(19, '0')}`;
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
        act: act as 'message',
        body,
        thread: null,
        meta,
        ts,
      }),
    );
    return id;
  }

  describe('buildDreamPacket — what a dream sees', async () => {
    it("carries the day's acts on the seat's own lanes, its note, and the team's insights since", async () => {
      const { db, team, ryder, izzo } = await seed();
      await saveMemory(db, ryder.id, { headline: 'h', body: 'yesterday: fence half done' });
      const mine = await openLane(
        db,
        team.id,
        team.slug,
        'ryder',
        { title: 'mine', claim: true },
        NOW - DAY / 2,
      );
      const theirs = await openLane(
        db,
        team.id,
        team.slug,
        'izzo',
        { title: 'theirs', claim: true },
        NOW - DAY / 2,
      );
      const stale = await openLane(
        db,
        team.id,
        team.slug,
        'ryder',
        { title: 'stale', claim: true },
        NOW - 3 * DAY,
      );

      await say(db, team, ryder, 'status_update', `step 1 on ${mine.id}`, NOW - 3 * 3600_000);
      await say(db, team, izzo, 'message', `review of ${mine.id}: looks right`, NOW - 2 * 3600_000);
      await say(db, team, izzo, 'status_update', `step 1 on ${theirs.id}`, NOW - 3600_000);
      await say(db, team, ryder, 'status_update', `old news on ${mine.id}`, NOW - 2 * DAY);
      await say(db, team, izzo, 'insight', 'PGlite is 4x slower on cold start', NOW - 3600_000, {
        headline: 'PGlite cold start',
        tags: ['perf'],
      });
      await say(db, team, izzo, 'insight', 'an old one', NOW - 2 * DAY, { headline: 'old' });

      const { packet, truncated } = await buildDreamPacket(db, team, ryder, { now: NOW });

      expect(packet.since).toBe(NOW - DREAM_BUDGET.default_since_ms);
      expect(packet.memory).toEqual({
        body: 'yesterday: fence half done',
        truncated: false,
        saved_at: expect.any(Number),
      });
      expect(packet.lanes.map((l) => l.id)).toEqual([mine.id]);
      expect(packet.lanes[0]!.acts.map((a) => [a.from, a.body])).toEqual([
        ['ryder', `step 1 on ${mine.id}`],
        ['izzo', `review of ${mine.id}: looks right`],
      ]);
      expect(packet.learned).toEqual([
        expect.objectContaining({ from: 'izzo', headline: 'PGlite cold start', tags: ['perf'] }),
      ]);
      expect(truncated).toBe(false);
      void stale;
    });

    it('the window starts at `since` when given', async () => {
      const { db, team, ryder, izzo } = await seed();
      await say(db, team, izzo, 'insight', 'before', NOW - 2 * 3600_000, { headline: 'before' });
      await say(db, team, izzo, 'insight', 'after', NOW - 3600_000, { headline: 'after' });
      const { packet } = await buildDreamPacket(db, team, ryder, {
        now: NOW,
        since: NOW - 90 * 60_000,
      });
      expect(packet.learned.map((i) => i.headline)).toEqual(['after']);
    });

    // 2026-10-03/04: three dreams read insights cut at 600 chars and argued over the clipped
    // condition ("promote if seen again"). An insight is never clipped, and says so per insight.
    it('carries every learned insight whole, flagged per insight', async () => {
      const { db, team, izzo, ryder } = await seed();
      const long = `${'y'.repeat(1_500)} — promote only if seen on a second date.`;
      await say(db, team, izzo, 'insight', long, NOW - 3600_000, { headline: 'long one' });
      const { packet, truncated } = await buildDreamPacket(db, team, ryder, { now: NOW });
      expect(packet.learned).toEqual([
        expect.objectContaining({ headline: 'long one', body: long, truncated: false }),
      ]);
      expect(truncated).toBe(false);
    });

    // Lane 01M454DC0H: miley (05:30:47Z) and ghost (05:32Z) dreamed two minutes apart on 2026-10-04
    // UTC — 22:3x on 10-03 in Los Angeles — and dated it a day apart in prose. One night, one key.
    it("names each insight's night by the working-hours key, so a UTC midnight is not two nights", async () => {
      const db = await openStore();
      const team = await createTeam(db, {
        slug: 'night',
        workingHours: {
          timezone: 'America/Los_Angeles',
          days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
          start: '08:00',
          end: '22:30',
        },
      });
      const miley = (await addMember(db, team, { name: 'miley', kind: 'agent' })).row;
      const ghost = (await addMember(db, team, { name: 'ghost', kind: 'agent' })).row;
      const a = Date.parse('2026-10-04T05:30:47Z');
      const b = Date.parse('2026-10-04T05:32:00Z');
      const nextNight = Date.parse('2026-10-05T05:31:00Z');
      await say(db, team, miley, 'insight', 'clip seen', a, { headline: 'm' });
      await say(db, team, ghost, 'insight', 'clip seen', b, { headline: 'g' });
      await say(db, team, ghost, 'insight', 'clip seen again', nextNight, { headline: 'g2' });
      const { packet } = await buildDreamPacket(db, team, ghost, {
        since: a - 1,
        now: nextNight + 60_000,
      });
      expect(packet.learned.map((i) => [i.headline, i.night])).toEqual([
        ['m', '2026-10-03'],
        ['g', '2026-10-03'],
        ['g2', '2026-10-04'],
      ]);
      expect(packet.night).toBe('2026-10-04');
    });

    it('ADR 522: the note and each insight carry their claims checked against now', async () => {
      const { db, team, ryder, izzo } = await seed();
      await saveMemory(db, ryder.id, { headline: 'h', body: 'Demo tomorrow. Nobody merges until then.' });
      await say(db, team, izzo, 'insight', 'Code freeze before the demo — hold off on refreshing.', NOW - DAY / 4, {
        headline: 'freeze',
      });
      await say(db, team, izzo, 'insight', 'Ordinary finding, nothing to check.', NOW - DAY / 5, {
        headline: 'plain',
      });
      const { packet } = await buildDreamPacket(db, team, ryder, { now: NOW });
      expect(packet.memory?.saved_at).toEqual(expect.any(Number));
      expect(packet.memory?.checks?.[0]).toMatchObject({ kind: 'rule', verdict: 'unsourced' });
      const [freeze, plain] = packet.learned;
      expect(freeze?.checks?.[0]).toMatchObject({ kind: 'rule', verdict: 'unsourced' });
      expect(plain?.checks).toBeUndefined();
    });

    it('fits the byte budget by dropping the oldest acts first, and keeps the note', async () => {
      const { db, team, ryder } = await seed();
      await saveMemory(db, ryder.id, { headline: 'h', body: 'note' });
      const lane = await openLane(
        db,
        team.id,
        team.slug,
        'ryder',
        { title: 'big', claim: true },
        NOW - 3600_000,
      );
      const big = 'x'.repeat(DREAM_BUDGET.act_body_chars);
      for (let i = 0; i < DREAM_BUDGET.lane_acts; i++)
        await say(db, team, ryder, 'status_update', `${lane.id} #${i} ${big}`, NOW - 3600_000 + i);

      const { packet, used_bytes, truncated } = await buildDreamPacket(db, team, ryder, {
        now: NOW,
      });

      expect(used_bytes).toBeLessThanOrEqual(DREAM_BUDGET.limit_bytes);
      expect(truncated).toBe(true);
      expect(packet.memory?.body).toBe('note');
      const acts = packet.lanes[0]!.acts;
      expect(acts.at(-1)!.body).toContain(`#${DREAM_BUDGET.lane_acts - 1} `);
      expect(packet.lanes[0]!.omitted + acts.length).toBe(DREAM_BUDGET.lane_acts);
    });
  });
});

describe('dreamMayWrite — the fence', () => {
  it('allows insights, its own note, and wiki pages', () => {
    expect(dreamMayWrite('ryder', { kind: 'act', act: 'insight' })).toEqual({ ok: true });
    expect(dreamMayWrite('ryder', { kind: 'memory', seat: 'ryder' })).toEqual({ ok: true });
    expect(dreamMayWrite('ryder', { kind: 'file', path: 'docs/wiki/pglite.md' })).toEqual({
      ok: true,
    });
    expect(dreamMayWrite('ryder', { kind: 'file', path: './docs/wiki/a/b.md' })).toEqual({
      ok: true,
    });
  });

  it.each([
    [{ kind: 'act', act: 'message' }, 'only insight'],
    [{ kind: 'act', act: 'ask' }, 'only insight'],
    [{ kind: 'memory', seat: 'izzo' }, 'own note'],
    [{ kind: 'file', path: 'packages/server/src/store/dream.ts' }, 'never code'],
    [{ kind: 'file', path: 'docs/wiki/../../packages/x.md' }, 'never code'],
    [{ kind: 'file', path: 'docs/wiki/notes.ts' }, 'never code'],
    [{ kind: 'lane' }, 'never moves a lane'],
    [{ kind: 'other', what: 'ring the doorbell' }, 'ring the doorbell'],
  ] as const)('refuses %o', (w, reason) => {
    const v = dreamMayWrite('ryder', w);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain(reason);
  });
});
