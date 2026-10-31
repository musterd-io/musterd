import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import {
  getQuestionNotify,
  inQuietHours,
  questionBuzzes,
  setQuestionNotify,
} from './questionNotify.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/** ADR 779 §5: a person's question-notification preferences. */
withDrivers('question notify prefs', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    return { db, team, nick };
  }

  it('no row is the defaults; a set round-trips; a bad shape is refused', async () => {
    const { db, team, nick } = await seed();
    expect(await getQuestionNotify(db, team.id, nick.id)).toEqual({});
    await setQuestionNotify(db, team.id, nick, {
      seats: { ryder: 'never' },
      channels: { app: 'quiet' },
    });
    expect(await getQuestionNotify(db, team.id, nick.id)).toEqual({
      seats: { ryder: 'never' },
      channels: { app: 'quiet' },
    });
    await expect(
      setQuestionNotify(db, team.id, nick, { seats: { ryder: 'loud' } } as never),
    ).rejects.toThrow();
  });

  it('quiet hours are the person’s working hours, else the team’s, else never', async () => {
    const { db, team, nick } = await seed();
    expect(await inQuietHours(db, team.id, nick.id, Date.UTC(2026, 9, 31, 3))).toBe(false);
    await db.run('UPDATE members SET working_hours = ? WHERE id = ?', [
      JSON.stringify({
        timezone: 'UTC',
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: '09:00',
        end: '17:00',
      }),
      nick.id,
    ]);
    expect(await inQuietHours(db, team.id, nick.id, Date.UTC(2026, 9, 31, 3))).toBe(true);
    expect(await inQuietHours(db, team.id, nick.id, Date.UTC(2026, 9, 31, 12))).toBe(false);
  });

  it('a blocking question buzzes by default, and not from a seat set to never', async () => {
    const { db, team, nick } = await seed();
    const ctx = { channel: 'app', seat: 'ryder', blocking: true, activeOnLive: false };
    expect(await questionBuzzes(db, team.id, nick.id, ctx)).toBe(true);
    await setQuestionNotify(db, team.id, nick, { seats: { ryder: 'never' } });
    expect(await questionBuzzes(db, team.id, nick.id, ctx)).toBe(false);
  });
});
