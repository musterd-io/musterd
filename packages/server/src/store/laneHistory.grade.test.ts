import { describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, laneHistory } from './audit.js';
import { createTeam } from './teams.js';

/** ADR 670: the lane history carries the closing row's review grade, so the chain can show it. */
withDrivers('laneHistory review grade', (openStore: () => Promise<Driver>) => {
  describe('laneHistory — review grade (ADR 670)', () => {
    async function closed(detail: Record<string, unknown>) {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      await appendAudit(db, team.id, {
        actor: 'dolly',
        action: 'lane.closed',
        target: '01LANE',
        result: 'allow',
        detail: { lane: '01LANE', state: 'done', verified: true, ...detail },
      });
      return (await laneHistory(db, team.id, '01LANE')).at(-1)!;
    }

    it('projects a known grade from the close row', async () => {
      expect((await closed({ review_grade: 'cross_family' })).review_grade).toBe('cross_family');
      expect((await closed({ review_grade: 'human' })).review_grade).toBe('human');
    });

    it('omits a grade it does not know, and one never recorded', async () => {
      expect((await closed({ review_grade: 'next_year' })).review_grade).toBeUndefined();
      expect((await closed({})).review_grade).toBeUndefined();
    });
  });
});
