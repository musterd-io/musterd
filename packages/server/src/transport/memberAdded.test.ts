import type { WSServerFrame } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { createTeam } from '../store/teams.js';
import { broadcastMemberAdded, broadcastReconciled } from './memberAdded.js';

let openStore: () => Promise<Driver>;

/**
 * A Member being created is news to the room (lane 01M3F81DD9): the team hears `presence: offline`
 * for the new name, which is what makes `/live` refetch its roster and see them arrive.
 */
function fakeHub() {
  const sent: { teamId: string; frame: WSServerFrame }[] = [];
  return {
    sent,
    broadcastTeam: (teamId: string, frame: WSServerFrame) => void sent.push({ teamId, frame }),
  };
}

withDrivers('memberAdded', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('broadcastMemberAdded (lane 01M3F81DD9)', () => {
    it('sends presence offline for the new name to the whole team', () => {
      const hub = fakeHub();
      broadcastMemberAdded(hub, 't1', 'ada');
      expect(hub.sent).toEqual([
        { teamId: 't1', frame: { type: 'presence', member: 'ada', status: 'offline' } },
      ]);
    });
  });

  describe('broadcastReconciled', async () => {
    it('announces added and revived seats, per team, and nothing else', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'dawn' });
      const hub = fakeHub();
      await broadcastReconciled({ db, hub: hub as never }, [
        { slug: 'dawn', added: ['ada'], revived: ['lin'] },
        { slug: 'nope', added: ['ghost'], revived: [] }, // an unknown slug is skipped, not thrown
      ]);
      expect(hub.sent.map((s) => [s.teamId, (s.frame as { member: string }).member])).toEqual([
        [team.id, 'ada'],
        [team.id, 'lin'],
      ]);
    });
  });
});
