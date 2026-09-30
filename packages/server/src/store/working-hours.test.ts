import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember, getMemberByName } from './members.js';
import { getTeamBySlug, createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

const hours = {
  timezone: 'America/Los_Angeles',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const,
  start: '11:00',
  end: '15:00',
};

withDrivers('working-hours', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('working-hours persistence', async () => {
    it('stores optional Team and Member schedules as JSON', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive', workingHours: hours });
      await addMember(db, team, {
        name: 'miley',
        kind: 'agent',
        workingHours: hours,
      });

      expect((await getTeamBySlug(db, 'revive'))?.working_hours).toBe(JSON.stringify(hours));
      expect((await getMemberByName(db, team.id, 'miley'))?.working_hours).toBe(
        JSON.stringify(hours),
      );
      await db.close();
    });

    it('keeps a missing Member schedule nullable for inheritance', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive', workingHours: hours });
      const member = await addMember(db, team, { name: 'miley', kind: 'agent' });

      expect((await getMemberByName(db, team.id, 'miley'))?.working_hours).toBeNull();
      expect((await getTeamBySlug(db, 'revive'))?.working_hours).toBe(JSON.stringify(hours));
      expect(member.row.working_hours).toBeNull();
      await db.close();
    });
  });
});
