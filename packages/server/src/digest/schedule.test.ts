import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember, getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';
import { DIGEST_SEAT, digestTick } from './schedule.js';

let openStore: () => Promise<Driver>;

// ADR 494 §5: the morning digest is posted at the start of working hours by a scheduled seat on its
// own schedule — never by a dream. One post per team per working day, as the `digest` service seat.
withDrivers('digest schedule (ADR 494 §5)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  const EVERY_DAY = {
    timezone: 'America/Los_Angeles',
    days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as ('mon' | 'tue')[],
    start: '08:00',
    end: '22:30',
  };
  const MORNING = Date.parse('2026-10-02T16:00:00Z'); // 09:00 PDT
  const NIGHT = Date.parse('2026-10-02T10:00:00Z'); // 03:00 PDT

  async function seed(hours = true) {
    const db = await openStore();
    const team = await createTeam(db, {
      slug: 'revive',
      ...(hours ? { workingHours: { ...EVERY_DAY, days: [...EVERY_DAY.days] } } : {}),
    });
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    return { db, team, ada };
  }

  const digests = (db: Driver, teamId: string) =>
    db.all<{ body: string; meta: string; from_member: string }>(
      `SELECT body, meta, from_member FROM messages
        WHERE team_id = ? AND meta IS NOT NULL AND json_extract(meta, '$.digest.day') IS NOT NULL`,
      [teamId],
    );

  it("posts the morning digest once, as the digest service seat, with last night's insights", async () => {
    const { db, team, ada } = await seed();
    // Saved at 23:00 PDT on Oct 1 — inside the night that ended at 08:00 on Oct 2.
    const at = Date.parse('2026-10-02T06:00:00Z');
    await insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: ulid(),
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' },
        act: 'insight',
        body: 'the tunnel drops idle peers',
        meta: { headline: 'the tunnel drops idle peers' },
        ts: at,
      }),
      { now: at },
    );
    expect(await digestTick(db, MORNING)).toBe(1);
    expect(await digestTick(db, MORNING + 60_000)).toBe(0);
    const rows = await digests(db, team.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.meta)).toEqual({ digest: { day: '2026-10-02' } });
    expect(rows[0]!.body).toContain('the tunnel drops idle peers');
    const seat = await getMemberByName(db, team.id, DIGEST_SEAT);
    expect(seat?.kind).toBe('service');
    expect(rows[0]!.from_member).toBe(seat!.id);
  });

  it('posts nothing outside working hours', async () => {
    const { db, team } = await seed();
    expect(await digestTick(db, NIGHT)).toBe(0);
    expect(await digests(db, team.id)).toHaveLength(0);
  });

  it('posts nothing, and mints no seat, for a team with no schedule', async () => {
    const { db, team } = await seed(false);
    expect(await digestTick(db, MORNING)).toBe(0);
    expect(await getMemberByName(db, team.id, DIGEST_SEAT)).toBeUndefined();
  });
});
