import type { WSServerFrame } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createTeam } from '../store/teams.js';
import { broadcastMemberAdded, broadcastReconciled } from './memberAdded.js';

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

describe('broadcastMemberAdded (lane 01M3F81DD9)', () => {
  it('sends presence offline for the new name to the whole team', () => {
    const hub = fakeHub();
    broadcastMemberAdded(hub, 't1', 'ada');
    expect(hub.sent).toEqual([
      { teamId: 't1', frame: { type: 'presence', member: 'ada', status: 'offline' } },
    ]);
  });
});

describe('broadcastReconciled', () => {
  it('announces added and revived seats, per team, and nothing else', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'dawn' });
    const hub = fakeHub();
    broadcastReconciled({ db, hub: hub as never }, [
      { slug: 'dawn', added: ['ada'], revived: ['lin'] },
      { slug: 'nope', added: ['ghost'], revived: [] }, // an unknown slug is skipped, not thrown
    ]);
    expect(hub.sent.map((s) => [s.teamId, (s.frame as { member: string }).member])).toEqual([
      [team.id, 'ada'],
      [team.id, 'lin'],
    ]);
  });
});
