import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { routeEnvelope } from '../protocol/route.js';
import { addMember } from './members.js';
import type { TeamRow } from './rows.js';
import { ftsQuery, rebuildInsightsFts, searchInsights } from './teamMemory.js';
import { createTeam } from './teams.js';

const ID = '01M0XINSIGHTTEST00000000000A';

/** Persist an insight through the real validate→persist→deliver path so triggers fire. */
async function saveInsight(db: Driver, ctx: Ctx, team: TeamRow, headline: string, body: string) {
  const { row: sender } = await addMember(db, team, { name: 'ghost', kind: 'agent', role: '' });
  await routeEnvelope(
    ctx,
    team,
    sender,
    makeEnvelope({
      id: ID + headline.slice(0, 4),
      team: team.slug,
      from: sender.name,
      to: { kind: 'team' },
      act: 'insight',
      body,
      meta: { headline, tags: ['daemon'] },
    }),
  );
}

function stubCtx(db: Driver): Ctx {
  return {
    db,
    traceDb: db,
    rosterRoots: [],
    config: {} as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

// The one module with a dialect branch above the Driver (ADR 479 Consequences: FTS5 `MATCH`
// locally, the tsvector table in Postgres) — so this file runs on both drivers by default.
withDrivers('team memory fold (ADR 327)', (open) => {
  it('finds an insight saved through the real route path', async () => {
    const db = await open();
    const team = await createTeam(db, { slug: 'dawn' });
    await saveInsight(
      db,
      stubCtx(db),
      team,
      'service install needs node >= 22',
      'the daemon crashloops from node 20',
    );

    const hits = await searchInsights(db, team.id, 'crashloops');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      from: 'ghost',
      headline: 'service install needs node >= 22',
      tags: ['daemon'],
    });
    await db.close();
  });

  it('is team-scoped', async () => {
    const db = await open();
    const dawn = await createTeam(db, { slug: 'dawn' });
    const dusk = await createTeam(db, { slug: 'dusk' });
    const ctx = stubCtx(db);
    await saveInsight(
      db,
      ctx,
      dawn,
      'wake leases are host-local',
      'never replicated across machines',
    );

    expect(await searchInsights(db, dusk.id, 'replicated')).toHaveLength(0);
    expect(await searchInsights(db, dawn.id, 'replicated')).toHaveLength(1);
    await db.close();
  });

  it('rebuilds the fold from the log alone (the cache property)', async () => {
    const db = await open();
    const team = await createTeam(db, { slug: 'dawn' });
    await saveInsight(
      db,
      stubCtx(db),
      team,
      'perf harness leaks chrome',
      'headless chrome processes outlive runs',
    );

    await db.exec('DELETE FROM insights_fts');
    expect(await searchInsights(db, team.id, 'chrome')).toHaveLength(0);

    expect(await rebuildInsightsFts(db)).toBe(1);
    expect(await searchInsights(db, team.id, 'chrome')).toHaveLength(1);
    await db.close();
  });
});

describe('FTS5 query text (SQLite only)', () => {
  it('sanitizes user query text into quoted FTS terms', () => {
    expect(ftsQuery('  daemon   "install" node22 ')).toBe('"daemon" """install""" "node22"');
    expect(ftsQuery('')).toBe('');
  });
});
