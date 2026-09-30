import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit } from './audit.js';
import { addMember } from './members.js';
import { attach } from './presence.js';
import {
  resolveQuiescence,
  quietestBusyMs,
  lastActionBySubject,
  QUIESCENCE_DEFAULT_QUIET_AFTER_MS,
} from './quiescence.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * The quiescence derivation (2026-08-03 design, spec in docs/superpowers/specs). Split from
 * `activity` because the display signal cannot answer the decision question: for agents `working`
 * is sticky forever once a status posts, and `connections > 0` measured as "busy" would have
 * deferred 95% of daemon refreshes (184/192, measured on the dogfood log). Meanwhile the audit
 * trail shows the team genuinely quiet most of the time — 44 lulls ≥ 2 min in 6 busy hours — so
 * "time since the newest audited action" is a signal with actual discriminating power.
 */

withDrivers('quiescence', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('resolveQuiescence (pure)', () => {
    const NOW = 10_000_000;

    it("is busy under the threshold, quiet at and beyond it — the line is the CALLER's", () => {
      expect(resolveQuiescence(NOW - 30_000, NOW, 120_000)).toEqual({
        state: 'busy',
        quiet_for_ms: 30_000,
        source: 'audit',
      });
      expect(resolveQuiescence(NOW - 120_000, NOW, 120_000).state).toBe('quiet');
      expect(resolveQuiescence(NOW - 300_000, NOW, 120_000)).toEqual({
        state: 'quiet',
        quiet_for_ms: 300_000,
        source: 'audit',
      });
      // Same instant, different threshold, different verdict — thresholds live in the consumer.
      expect(resolveQuiescence(NOW - 30_000, NOW, 10_000).state).toBe('quiet');
    });

    it('is unknown when there is no observed action — never quiet-by-absence', () => {
      expect(resolveQuiescence(null, NOW, 120_000)).toEqual({
        state: 'unknown',
        quiet_for_ms: null,
        source: 'audit',
      });
    });

    it('clamps a clock-skewed future action to busy-now rather than a negative age', () => {
      const q = resolveQuiescence(NOW + 5_000, NOW, 120_000);
      expect(q.state).toBe('busy');
      expect(q.quiet_for_ms).toBe(0);
    });
  });

  describe('quietestBusyMs (db read for /health)', async () => {
    async function seed() {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
      const lin = (await addMember(db, team, { name: 'lin', kind: 'agent' })).row;
      const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
      return { db, team, ada, lin, nick };
    }
    const act = async (db: any, teamId: string, actor: string, at: number) => {
      vi.setSystemTime(at);
      await appendAudit(db, teamId, {
        actor,
        action: 'roster.role_query',
        target: null,
        result: 'allow',
      });
    };

    it('returns the age of the most recent action across LIVE agent seats', async () => {
      vi.useFakeTimers();
      try {
        const { db, team, ada, lin } = await seed();
        const now = 10_000_000;
        vi.setSystemTime(now);
        await attach(db, ada.id, 'claude-code', 'c1');
        await attach(db, lin.id, 'claude-code', 'c2');
        await act(db, team.id, 'ada', now - 300_000); // quiet 5m
        await act(db, team.id, 'lin', now - 40_000); // quiet 40s ← the minimum
        vi.setSystemTime(now);
        expect(await quietestBusyMs(db, { now, presenceTimeoutMs: 60_000 })).toBe(40_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores actions by seats that are no longer live, and by humans', async () => {
      vi.useFakeTimers();
      try {
        const { db, team, ada } = await seed();
        const now = 10_000_000;
        vi.setSystemTime(now);
        await attach(db, ada.id, 'claude-code', 'c1');
        await act(db, team.id, 'ada', now - 300_000);
        // lin acted 5s ago but holds no live presence; nick is live but human. Neither may win.
        await act(db, team.id, 'lin', now - 5_000);
        await act(db, team.id, 'nick', now - 1_000);
        vi.setSystemTime(now);
        expect(await quietestBusyMs(db, { now, presenceTimeoutMs: 60_000 })).toBe(300_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is null when no live agent seat has any action in the lookback — unknown, not zero', async () => {
      vi.useFakeTimers();
      try {
        const { db, team, ada } = await seed();
        const now = 10_000_000;
        vi.setSystemTime(now);
        await attach(db, ada.id, 'claude-code', 'c1');
        // One action, but far outside the lookback window: stale evidence is no evidence.
        await act(db, team.id, 'ada', now - 3 * 60 * 60_000);
        vi.setSystemTime(now);
        expect(
          await quietestBusyMs(db, { now, presenceTimeoutMs: 60_000, lookbackMs: 60 * 60_000 }),
        ).toBeNull();
        // And with no live seats at all it is also null.
        const empty = await openStore();
        await createTeam(empty, { slug: 't' });
        expect(await quietestBusyMs(empty, { now, presenceTimeoutMs: 60_000 })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('lastActionBySubject (per-seat read for the roster + wake pool, ADR 219)', async () => {
    async function seed() {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      await addMember(db, team, { name: 'ada', kind: 'agent' });
      await addMember(db, team, { name: 'lin', kind: 'agent' });
      await addMember(db, team, { name: 'nick', kind: 'human' });
      return { db, team };
    }
    const act = async (db: any, teamId: string, actor: string, at: number) => {
      vi.setSystemTime(at);
      await appendAudit(db, teamId, {
        actor,
        action: 'roster.role_query',
        target: null,
        result: 'allow',
      });
    };

    it('maps each subject to its NEWEST action, and omits seats with none', async () => {
      vi.useFakeTimers();
      try {
        const { db, team } = await seed();
        const now = 10_000_000;
        await act(db, team.id, 'ada', now - 300_000);
        await act(db, team.id, 'ada', now - 20_000); // newest wins
        await act(db, team.id, 'nick', now - 1_000);
        vi.setSystemTime(now);
        const seen = await lastActionBySubject(db, team.id, { now });
        expect(seen.get('ada')).toBe(now - 20_000);
        // Humans are included here (unlike /health): the roster renders every seat, and the
        // agents-only narrowing is the WAKE consumer's, not this read's.
        expect(seen.get('nick')).toBe(now - 1_000);
        // Absent, never zero — an actor with no audited action is unknowable, not quiet.
        expect(seen.has('lin')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops evidence older than the lookback, and never leaks across teams', async () => {
      vi.useFakeTimers();
      try {
        const { db, team } = await seed();
        const other = await createTeam(db, { slug: 'other' });
        await addMember(db, other, { name: 'ada', kind: 'agent' });
        const now = 10_000_000;
        await act(db, team.id, 'ada', now - 3 * 60 * 60_000); // stale evidence is no evidence
        await act(db, other.id, 'lin', now - 5_000); // another team's seat, same daemon
        vi.setSystemTime(now);
        const seen = await lastActionBySubject(db, team.id, { now, lookbackMs: 60 * 60_000 });
        expect(seen.has('ada')).toBe(false);
        expect(seen.has('lin')).toBe(false);
        expect((await lastActionBySubject(db, other.id, { now })).get('lin')).toBe(now - 5_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('excludeActions omits those rows from the newest-work map', async () => {
      vi.useFakeTimers();
      try {
        const { db, team } = await seed();
        const now = 10_000_000;
        vi.setSystemTime(now - 60_000);
        await appendAudit(db, team.id, {
          actor: 'ada',
          action: 'roster.role_query',
          target: null,
          result: 'allow',
        });
        vi.setSystemTime(now);
        await appendAudit(db, team.id, {
          actor: 'ada',
          action: 'occupancy.model_attested',
          target: 'ada',
          result: 'allow',
        });
        const all = await lastActionBySubject(db, team.id, { now });
        const work = await lastActionBySubject(db, team.id, {
          now,
          excludeActions: ['occupancy.model_attested'],
        });
        expect(all.get('ada')).toBe(now);
        expect(work.get('ada')).toBe(now - 60_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('feeds resolveQuiescence at the documented default line', () => {
      // The default exists so the wire's `state` label means something; `quiet_for_ms` stays the
      // authority for any consumer drawing its own line.
      expect(QUIESCENCE_DEFAULT_QUIET_AFTER_MS).toBe(120_000);
      const now = 10_000_000;
      expect(resolveQuiescence(now - 10_000, now, QUIESCENCE_DEFAULT_QUIET_AFTER_MS).state).toBe(
        'busy',
      );
      expect(resolveQuiescence(now - 600_000, now, QUIESCENCE_DEFAULT_QUIET_AFTER_MS).state).toBe(
        'quiet',
      );
    });
  });
});
