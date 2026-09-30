import { makeEnvelope, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  circularHandoffs,
  countDiversityFlagsByTeam,
  deriveMast,
  diversityFlags,
  stalledThreads,
  timeToUnblock,
} from './mast.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 40 * DAY;

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
  const bob = (await addMember(db, team, { name: 'bob', kind: 'agent' })).row;
  return { db, team, nick, ada, bob };
}

async function msg(
  db: Database,
  team: TeamRow,
  from: MemberRow,
  to: MemberRow | null,
  act: Act,
  id: string,
  ts: number,
  opts: { thread?: string; meta?: Record<string, unknown> } = {},
) {
  await insertMessage(
    db,
    team.id,
    from.id,
    to?.id ?? null,
    makeEnvelope({
      id,
      team: team.slug,
      from: from.name,
      to: to ? { kind: 'member', name: to.name } : { kind: 'team' },
      act,
      body: 'x',
      thread: opts.thread ?? null,
      meta: opts.meta ?? null,
      ts,
    }),
  );
}

withDrivers('mast', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('timeToUnblock (ADR 091)', async () => {
    it('measures open→close for accept-by-reply and resolve-on-thread; empty-safe', async () => {
      const { db, team, nick, ada } = await seed();
      expect(await timeToUnblock(db, team.id, NOW)).toEqual({
        closed: 0,
        median_ms: null,
        p95_ms: null,
      });

      // accept names the handoff → 5m loop.
      await msg(db, team, nick, ada, 'handoff', 'h1', NOW - HOUR);
      await msg(db, team, ada, nick, 'accept', 'a1', NOW - HOUR + 5 * 60_000, {
        meta: { in_reply_to: 'h1' },
      });
      // resolve closes the request_help's thread → 30m loop.
      await msg(db, team, nick, null, 'request_help', 'r1', NOW - HOUR, { thread: 't1' });
      await msg(db, team, ada, null, 'resolve', 'v1', NOW - HOUR + 30 * 60_000, { thread: 't1' });

      const t = await timeToUnblock(db, team.id, NOW);
      expect(t.closed).toBe(2);
      expect(t.median_ms).toBe(30 * 60_000);
      expect(t.p95_ms).toBe(30 * 60_000);
    });

    it('ignores loops closed outside the 7d window', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h1', NOW - 20 * DAY);
      await msg(db, team, ada, nick, 'accept', 'a1', NOW - 19 * DAY, {
        meta: { in_reply_to: 'h1' },
      });
      expect((await timeToUnblock(db, team.id, NOW)).closed).toBe(0);
    });
  });

  describe('stalledThreads (ADR 091)', async () => {
    it('flags a multi-act unresolved thread quiet past 24h; resolve or activity clears it', async () => {
      const { db, team, nick, ada } = await seed();
      // Stalled: two acts, quiet 2 days, no resolve.
      await msg(db, team, nick, ada, 'handoff', 'h1', NOW - 3 * DAY, { thread: 'stall' });
      await msg(db, team, ada, nick, 'accept', 'a1', NOW - 2 * DAY, {
        thread: 'stall',
        meta: { in_reply_to: 'h1' },
      });
      // Not stalled: resolved.
      await msg(db, team, nick, null, 'request_help', 'r1', NOW - 3 * DAY, { thread: 'done' });
      await msg(db, team, ada, null, 'resolve', 'v1', NOW - 2 * DAY, { thread: 'done' });
      // Not stalled: still active.
      await msg(db, team, nick, ada, 'message', 'm1', NOW - 3 * DAY, { thread: 'live' });
      await msg(db, team, ada, nick, 'message', 'm2', NOW - HOUR, { thread: 'live' });
      // Not stalled: single act.
      await msg(db, team, nick, ada, 'message', 'm3', NOW - 3 * DAY, { thread: 'solo' });

      const stalled = await stalledThreads(db, team.id, NOW);
      expect(stalled).toHaveLength(1);
      expect(stalled[0]).toMatchObject({
        thread: 'stall',
        acts: 2,
        participants: 2,
        last_act: 'accept',
      });
      expect(stalled[0]!.quiet_ms).toBe(2 * DAY);
    });
  });

  describe('circularHandoffs (ADR 091)', async () => {
    it('flags a handoff returning to a prior participant; a linear chain stays clean', async () => {
      const { db, team, nick, ada, bob } = await seed();
      // Circular: nick→ada→bob→nick on one thread.
      await msg(db, team, nick, ada, 'handoff', 'c1', NOW - 3 * HOUR, { thread: 'circle' });
      await msg(db, team, ada, bob, 'handoff', 'c2', NOW - 2 * HOUR, { thread: 'circle' });
      await msg(db, team, bob, nick, 'handoff', 'c3', NOW - HOUR, { thread: 'circle' });
      // Linear: nick→ada, then ada→bob on another thread.
      await msg(db, team, nick, ada, 'handoff', 'l1', NOW - 3 * HOUR, { thread: 'line' });
      await msg(db, team, ada, bob, 'handoff', 'l2', NOW - 2 * HOUR, { thread: 'line' });

      const circles = await circularHandoffs(db, team.id, NOW);
      expect(circles).toHaveLength(1);
      expect(circles[0]).toMatchObject({ thread: 'circle', hops: 3 });
    });
  });

  describe('diversityFlags (ADR 101)', async () => {
    it('flags a single-family approval chain; a cross-family chain stays silent', async () => {
      const { db, team, nick, ada, bob } = await seed();
      // Single-family: both acts stamped claude-* → flagged.
      await msg(db, team, ada, bob, 'handoff', 'h1', NOW - 2 * HOUR, {
        thread: 'same',
        meta: { model: 'claude-sonnet-5' },
      });
      await msg(db, team, bob, ada, 'accept', 'a1', NOW - HOUR, {
        thread: 'same',
        meta: { in_reply_to: 'h1', model: 'claude-opus-4-8' },
      });
      // Cross-family: claude vs gpt → diverse, silent.
      await msg(db, team, ada, bob, 'request_help', 'r1', NOW - 2 * HOUR, {
        thread: 'cross',
        meta: { model: 'claude-opus-4-8' },
      });
      await msg(db, team, bob, ada, 'accept', 'a2', NOW - HOUR, {
        thread: 'cross',
        meta: { in_reply_to: 'r1', model: 'gpt-5.2-codex' },
      });

      const flags = await diversityFlags(db, team.id, NOW);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({
        thread: 'same',
        kind: 'handoff',
        participants: 2,
        families: ['claude'],
        verdict: 'flagged',
      });
      // #207: the per-team gauge form — one point per team with a live flag, keyed on team slug.
      expect(await countDiversityFlagsByTeam(db, NOW)).toEqual([{ team: team.slug, count: 1 }]);
      // nick unused in this test — keep the seed signature.
      void nick;
    });

    it('marks a chain with an unattested link unverifiable — never presumed diverse', async () => {
      const { db, team, ada, bob } = await seed();
      await msg(db, team, ada, bob, 'handoff', 'h1', NOW - 2 * HOUR, {
        thread: 't',
        meta: { model: 'claude-opus-4-8' },
      });
      await msg(db, team, bob, ada, 'accept', 'a1', NOW - HOUR, {
        thread: 't',
        meta: { in_reply_to: 'h1' },
      });

      const flags = await diversityFlags(db, team.id, NOW);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({ thread: 't', verdict: 'unverifiable' });
    });

    it('ignores self-answered chains and closures outside the window', async () => {
      const { db, team, ada, bob } = await seed();
      // Self-answer: same seat opens and closes — not an agreement between actors.
      await msg(db, team, ada, bob, 'handoff', 'h1', NOW - 2 * HOUR, {
        thread: 'self',
        meta: { model: 'claude-opus-4-8' },
      });
      await msg(db, team, ada, bob, 'accept', 'a1', NOW - HOUR, {
        thread: 'self',
        meta: { in_reply_to: 'h1', model: 'claude-opus-4-8' },
      });
      // Out of window.
      await msg(db, team, ada, bob, 'handoff', 'h2', NOW - 20 * DAY, {
        thread: 'old',
        meta: { model: 'claude-opus-4-8' },
      });
      await msg(db, team, bob, ada, 'accept', 'a2', NOW - 19 * DAY, {
        thread: 'old',
        meta: { in_reply_to: 'h2', model: 'claude-opus-4-8' },
      });

      expect(await diversityFlags(db, team.id, NOW)).toEqual([]);
    });
  });

  describe('deriveMast (the report block)', async () => {
    it('composes the views and filters ignored_help off the ADR 090 ledger by age', async () => {
      const { db, team, nick } = await seed();
      await msg(db, team, nick, null, 'request_help', 'old', NOW - 2 * HOUR); // ignored (> 1h)
      await msg(db, team, nick, null, 'request_help', 'new', NOW - 10 * 60_000); // fresh — not ignored yet

      const m = await deriveMast(db, team.id, NOW);
      expect(m.window_days).toBe(7);
      expect(m.ignored_help.map((d) => d.id)).toEqual(['old']);
      expect(m.stalled_threads).toEqual([]);
      expect(m.circular_handoffs).toEqual([]);
      expect(m.diversity).toEqual([]);
    });
  });
});
