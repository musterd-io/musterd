import { PolicyOverrideSchema, ResidencyPolicySchema, sparsifyPolicy } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDb } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { createTeam, getPolicy, getStoredPolicy, setPolicy } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('teams.policy', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    return { db, team };
  }

  /** The stored blob, straight off the row — the thing every assertion here is really about. */
  async function storedRaw(db: ReturnType<typeof openDb>, teamId: string): Promise<unknown> {
    const row = await db.get('SELECT policy FROM teams WHERE id = ?', [teamId]);
    return row?.policy ? JSON.parse(row.policy) : null;
  }

  describe('setPolicy stores only what was chosen (ADR 185)', async () => {
    it('one knob written ⇒ one knob stored — the assertion whose absence let this ship', async () => {
      const { db, team } = await seed();
      await setPolicy(db, team.id, { standing_reseat_known_agents: true });
      expect(await storedRaw(db, team.id)).toEqual({ standing_reseat_known_agents: true });
    });

    it('a nested residency knob stays sparse THROUGH the sub-object, not just at the top', async () => {
      const { db, team } = await seed();
      await setPolicy(db, team.id, { residency: { cooldown_ms: 60_000 } });
      expect(await storedRaw(db, team.id)).toEqual({ residency: { cooldown_ms: 60_000 } });
    });

    it('the enforcement sub-object is sparse too', async () => {
      const { db, team } = await seed();
      await setPolicy(db, team.id, { allow_pre_issued_grants: true });
      expect(await storedRaw(db, team.id)).not.toHaveProperty('enforcement');
    });

    it('replace semantics: a later write drops keys the new doc omits', async () => {
      const { db, team } = await seed();
      await setPolicy(db, team.id, {
        standing_reseat_known_agents: true,
        residency: { hourly_cap: 5 },
      });
      await setPolicy(db, team.id, { residency: { hourly_cap: 5 } });
      expect(await storedRaw(db, team.id)).toEqual({ residency: { hourly_cap: 5 } });
    });

    it('deleting the webhook key restores "unset = no outbound call ever", not a stored default', async () => {
      const { db, team } = await seed();
      await setPolicy(db, team.id, { ask_slack_webhook: 'https://hooks.slack.example/x' });
      await setPolicy(db, team.id, {});
      expect(await storedRaw(db, team.id)).toEqual({});
      expect((await getPolicy(db, team.id)).ask_slack_webhook).toBeUndefined();
    });
  });

  describe('reads still see a fully-populated policy', async () => {
    it('getPolicy fills every default over a sparse row — consumers are untouched', async () => {
      const { db, team } = await seed();
      await setPolicy(db, team.id, { residency: { cooldown_ms: 60_000 } });
      const policy = await getPolicy(db, team.id);
      expect(policy.residency.cooldown_ms).toBe(60_000);
      expect(policy.residency.hourly_cap).toBe(ResidencyPolicySchema.parse({}).hourly_cap);
      expect(policy.allow_pre_issued_grants).toBe(false);
      expect(policy.enforcement.classes).toEqual([]);
    });

    it('getStoredPolicy returns the sparse doc — {} for a team that never wrote one', async () => {
      const { db, team } = await seed();
      expect(await getStoredPolicy(db, team.id)).toEqual({});
      await setPolicy(db, team.id, { residency: { lane: 'interrupt' } });
      expect(await getStoredPolicy(db, team.id)).toEqual({ residency: { lane: 'interrupt' } });
    });

    /**
     * The regression that actually cost an afternoon: on 2026-07-29 `transcript_max_bytes` moved from
     * 10 MiB to 256 KiB in the schema and the change was a no-op on `revive`, because writing ONE
     * unrelated knob had frozen every other value in the row. Simulated here by moving a default after
     * a write, which is what a recalibration is.
     */
    it('a schema default that moves AFTER a write reaches the team (the #530 no-op)', async () => {
      const { db, team } = await seed();
      await setPolicy(db, team.id, { standing_reseat_known_agents: true });

      const retuned = await getPolicy(db, team.id);
      expect(retuned.standing_reseat_known_agents).toBe(true);
      // Nothing about the untouched knobs is pinned in the row, so they resolve from the schema —
      // whatever it says today, and whatever it says after the next recalibration.
      expect(await storedRaw(db, team.id)).not.toHaveProperty('residency');
      expect(retuned.residency.transcript_max_bytes).toBe(
        ResidencyPolicySchema.parse({}).transcript_max_bytes,
      );
    });
  });

  describe('spend_cap_usd (ADR 602)', () => {
    it('stores only the cap, reads it back, and clears it by omission', async () => {
      const { db, team } = await seed();
      expect((await getPolicy(db, team.id)).spend_cap_usd).toBeUndefined();
      const fresh = await storedRaw(db, team.id);
      if (fresh && typeof fresh === 'object') expect(fresh).not.toHaveProperty('spend_cap_usd');

      await setPolicy(db, team.id, { spend_cap_usd: 12.5 });
      expect(await storedRaw(db, team.id)).toEqual({ spend_cap_usd: 12.5 });
      expect((await getPolicy(db, team.id)).spend_cap_usd).toBe(12.5);

      await setPolicy(db, team.id, {});
      expect(await storedRaw(db, team.id)).toEqual({});
      expect((await getPolicy(db, team.id)).spend_cap_usd).toBeUndefined();
    });

    it('rejects zero, a negative, and a value past the ceiling', async () => {
      const { db, team } = await seed();
      await expect(setPolicy(db, team.id, { spend_cap_usd: 0 })).rejects.toThrow();
      await expect(setPolicy(db, team.id, { spend_cap_usd: -5 })).rejects.toThrow();
      await expect(setPolicy(db, team.id, { spend_cap_usd: 1_000_000.01 })).rejects.toThrow();
      expect((await getPolicy(db, team.id)).spend_cap_usd).toBeUndefined();
    });
  });

  describe('spend_approval_usd (ADR 635)', () => {
    it('stores only the threshold, reads it back, and clears it by omission', async () => {
      const { db, team } = await seed();
      expect((await getPolicy(db, team.id)).spend_approval_usd).toBeUndefined();
      const fresh = await storedRaw(db, team.id);
      if (fresh && typeof fresh === 'object')
        expect(fresh).not.toHaveProperty('spend_approval_usd');

      await setPolicy(db, team.id, { spend_approval_usd: 12.5 });
      expect(await storedRaw(db, team.id)).toEqual({ spend_approval_usd: 12.5 });
      expect((await getPolicy(db, team.id)).spend_approval_usd).toBe(12.5);

      await setPolicy(db, team.id, {});
      expect(await storedRaw(db, team.id)).toEqual({});
      expect((await getPolicy(db, team.id)).spend_approval_usd).toBeUndefined();
    });

    it('rejects zero, a negative, and a value past the ceiling', async () => {
      const { db, team } = await seed();
      await expect(setPolicy(db, team.id, { spend_approval_usd: 0 })).rejects.toThrow();
      await expect(setPolicy(db, team.id, { spend_approval_usd: -5 })).rejects.toThrow();
      await expect(setPolicy(db, team.id, { spend_approval_usd: 1_000_000.01 })).rejects.toThrow();
      expect((await getPolicy(db, team.id)).spend_approval_usd).toBeUndefined();
    });
  });

  /**
   * The v26 data rewrite. The input below is the REAL `revive` row as it stood on 2026-07-30 — the one
   * non-NULL policy in the live fleet, and the whole population this migration has to be right about.
   */
  describe('sparsifyPolicy — keep-if-differs, strip-if-equal (ADR 185 migration)', () => {
    const REVIVE_ROW = {
      allow_pre_issued_grants: false,
      standing_reseat_known_agents: true,
      ask_fallback_to_nonadmin: false,
      residency: {
        lane: 'both',
        cooldown_ms: 1_800_000,
        hourly_cap: 2,
        attempt_cap: 3,
        tool_policy: 'reply-only',
        timeout_ms: 300_000,
        transcript_max_bytes: 262_144,
      },
      enforcement: { classes: [] },
    };

    it('keeps the one knob nick actually chose and strips the six the parse baked in', () => {
      // standing_reseat_known_agents differs from its `false` default ⇒ deliberate, kept. Everything
      // else equals the current default ⇒ stripped, and goes back to tracking it.
      expect(sparsifyPolicy(REVIVE_ROW)).toEqual({ standing_reseat_known_agents: true });
    });

    it('a value that differs from the default survives, nested or flat', () => {
      expect(
        sparsifyPolicy({ ...REVIVE_ROW, residency: { ...REVIVE_ROW.residency, hourly_cap: 7 } }),
      ).toEqual({ standing_reseat_known_agents: true, residency: { hourly_cap: 7 } });
    });

    it('a knob with no default at all is always kept — it can only be there deliberately', () => {
      expect(
        sparsifyPolicy({ ...REVIVE_ROW, ask_slack_webhook: 'https://hooks.slack.example/x' }),
      ).toEqual({
        standing_reseat_known_agents: true,
        ask_slack_webhook: 'https://hooks.slack.example/x',
      });
      expect(sparsifyPolicy({ residency: { ...REVIVE_ROW.residency, budget_usd: 2 } })).toEqual({
        residency: { budget_usd: 2 },
      });
    });

    it('a declared enforcement class survives; an empty table does not', () => {
      const classes = [
        {
          class: 'packages/server/**',
          kind: 'contended-surface' as const,
          match: ['packages/server/**'],
          posture: 'block' as const,
        },
      ];
      expect(sparsifyPolicy({ enforcement: { classes } })).toEqual({ enforcement: { classes } });
      expect(sparsifyPolicy({ enforcement: { classes: [] } })).toEqual({});
    });

    it('is idempotent, and a NULL/garbage blob yields {}', () => {
      const once = sparsifyPolicy(REVIVE_ROW);
      expect(sparsifyPolicy(once)).toEqual(once);
      expect(sparsifyPolicy(null)).toEqual({});
      expect(sparsifyPolicy('nonsense')).toEqual({});
    });
  });

  describe('PolicyOverrideSchema', () => {
    it('accepts an empty doc and a deeply partial one', () => {
      expect(PolicyOverrideSchema.parse({})).toEqual({});
      expect(PolicyOverrideSchema.parse({ residency: { hourly_cap: 3 } })).toEqual({
        residency: { hourly_cap: 3 },
      });
    });

    it('still validates the values it is given', () => {
      // 30s is below the 60s floor — sparseness must not become "anything goes".
      expect(() => PolicyOverrideSchema.parse({ residency: { cooldown_ms: 30_000 } })).toThrow();
      expect(() => PolicyOverrideSchema.parse({ ask_slack_webhook: 'not-a-url' })).toThrow();
    });
  });
});
