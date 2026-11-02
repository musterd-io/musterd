import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { HOST_KEY_USE_FOLD_WINDOW_MS, appendAudit, foldHostKeyUse } from './audit.js';
import type { AuditRow } from './audit.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('auditFold', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  const used = (target: string) => ({
    actor: null,
    action: 'bootstrap_credential.used' as const,
    target,
    result: 'allow' as const,
    detail: { use: 'host', target: 'cloud-delta-2' },
  });
  const rows = (db: Driver, teamId: string) =>
    db.all<AuditRow>(
      `SELECT * FROM audit WHERE team_id = ? AND action = 'bootstrap_credential.used' ORDER BY ts, id`,
      [teamId],
    );

  /** ADR 786 — a host loop's polling folds into one `bootstrap_credential.used` row per hour. */
  describe('foldHostKeyUse', () => {
    it('the second use inside the window counts on the first row instead of adding one', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      await appendAudit(db, team.id, used('cred-1'));
      await appendAudit(db, team.id, used('cred-1'));
      await appendAudit(db, team.id, used('cred-1'));
      const all = await rows(db, team.id);
      expect(all).toHaveLength(1);
      const detail = JSON.parse(all[0]!.detail!) as Record<string, unknown>;
      expect(detail.uses).toBe(3);
      expect(detail.use).toBe('host');
      expect(detail.target).toBe('cloud-delta-2');
      expect(typeof detail.last_ts).toBe('number');
      expect(detail.last_ts as number).toBeGreaterThanOrEqual(all[0]!.ts);
    });

    it('a different credential, a replicated row, or a row past the window each start a new row', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      await appendAudit(db, team.id, used('cred-1'));
      await appendAudit(db, team.id, used('cred-2'));
      expect(await rows(db, team.id)).toHaveLength(2);

      // A peer's row is its fact: never edited here.
      const first = (await rows(db, team.id))[0]!;
      await db.run('UPDATE audit SET origin_node = ?, origin_seq = ? WHERE id = ?', [
        'peer',
        7,
        first.id,
      ]);
      await appendAudit(db, team.id, used('cred-1'));
      const afterPeer = await rows(db, team.id);
      expect(afterPeer).toHaveLength(3);
      expect(JSON.parse(afterPeer.find((r) => r.id === first.id)!.detail!)).not.toHaveProperty(
        'uses',
      );

      // Past the window the newest local row is too old to take the use.
      const local = afterPeer.find((r) => r.target === 'cred-1' && r.origin_seq === 0)!;
      const later = Date.now() + HOST_KEY_USE_FOLD_WINDOW_MS + 1;
      expect(await foldHostKeyUse(db, team.id, used('cred-1'), later)).toBe(false);
      expect(await foldHostKeyUse(db, team.id, used('cred-1'))).toBe(true);
      const bumped = (await rows(db, team.id)).find((r) => r.id === local.id)!;
      expect((JSON.parse(bumped.detail!) as { uses: number }).uses).toBe(2);
    });

    it('only bootstrap_credential.used folds; a use with no target is appended as-is', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      await appendAudit(db, team.id, { ...used('x'), target: null });
      await appendAudit(db, team.id, { ...used('x'), target: null });
      expect(await rows(db, team.id)).toHaveLength(2);
    });
  });
});
