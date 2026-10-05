import { makeEnvelope, WAKE_CONTEXT_BUDGET, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { openLane } from './lanes.js';
import { addMember } from './members.js';
import { saveMemory } from './memory.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';
import { deriveContext, truncateBytes, truncateChars } from './wakeContextBody.js';

let openStore: () => Promise<Driver>;

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
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
  opts: { thread?: string; body?: string; meta?: Record<string, unknown> } = {},
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
      body: opts.body ?? 'x',
      thread: opts.thread ?? null,
      meta: opts.meta ?? null,
      ts,
    }),
  );
}

withDrivers('wakeContextBody', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('stored claims checked on read (ADR 522)', () => {
    it("a woken seat's memory and the handoff that woke it carry their checks", async () => {
      const { db, team, nick, ada } = await seed();
      const done = await openLane(db, team.id, team.slug, 'Ada', { title: 'old work', claim: true });
      await db.run("UPDATE lanes SET state = 'done' WHERE id = ?", [done.id]);
      await saveMemory(db, ada.id, { headline: 'h', body: `carrying ${done.id}` });
      await msg(db, team, nick, ada, 'handoff', 'hf1', 1_000, {
        body: "Take this over. Don't merge until the demo is done.",
      });
      const { context } = await deriveContext(db, team, ada, { threadId: 'hf1' });
      expect(context.checks?.map((c) => [c.source, c.kind, c.verdict])).toEqual([
        ['memory', 'lane', 'ended'],
        ['handoff', 'rule', 'unsourced'],
      ]);
      expect(context.checks?.[1]?.source_id).toBe('hf1');
    });

    it('says nothing when there is nothing to correct', async () => {
      const { db, team, ada } = await seed();
      await saveMemory(db, ada.id, { headline: 'h', body: 'halfway through the tests' });
      expect((await deriveContext(db, team, ada, {})).context.checks).toBeUndefined();
    });
  });

  describe('truncation helpers (ADR 430)', () => {
    it('cuts at the limit and flags it, and leaves short text alone', () => {
      expect(truncateChars('abcdef', 4)).toEqual({ text: 'abcd', truncated: true });
      expect(truncateChars('abc', 4)).toEqual({ text: 'abc', truncated: false });
      // bytes: a multi-byte character is never split
      expect(truncateBytes('aé€', 4)).toEqual({ text: 'aé', truncated: true });
      expect(truncateBytes('aé€', 6)).toEqual({ text: 'aé€', truncated: false });
    });
  });

  describe('deriveContext (ADR 430)', async () => {
    it("carries the waking thread oldest→newest, attributed, including the recipient's own acts", async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'message', 'm1', 1_000, { body: 'first' });
      await msg(db, team, ada, nick, 'message', 'm2', 1_001, { thread: 'm1', body: 'my reply' });
      await msg(db, team, nick, ada, 'steer', 'm3', 1_002, { thread: 'm1', body: 'do the thing' });
      const { context, fetch } = await deriveContext(db, team, ada, { threadId: 'm1' });
      expect(context.thread?.acts.map((a) => [a.from, a.act, a.body])).toEqual([
        ['nick', 'message', 'first'],
        ['Ada', 'message', 'my reply'],
        ['nick', 'steer', 'do the thing'],
      ]);
      expect(context.thread?.omitted).toBe(0);
      expect(fetch).not.toContain('inbox_thread');
    });

    it('keeps the last 8 acts and counts the rest as omitted', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'message', 't0', 1_000);
      for (let i = 1; i <= 11; i++)
        await msg(db, team, nick, ada, 'message', `t${i}`, 1_000 + i, {
          thread: 't0',
          body: `n${i}`,
        });
      const { context, fetch } = await deriveContext(db, team, ada, { threadId: 't0' });
      expect(context.thread?.acts).toHaveLength(WAKE_CONTEXT_BUDGET.thread_acts);
      expect(context.thread?.acts[0]?.id).toBe('t4');
      expect(context.thread?.omitted).toBe(4);
      expect(fetch).toContain('inbox_thread');
    });

    it('cuts a long body at 600 chars and flags it', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'message', 'l1', 1_000, { body: 'y'.repeat(1_000) });
      const { context } = await deriveContext(db, team, ada, { threadId: 'l1' });
      expect(context.thread?.acts[0]).toMatchObject({ truncated: true });
      expect(context.thread?.acts[0]?.body).toHaveLength(WAKE_CONTEXT_BUDGET.act_body_chars);
    });

    it('lists open directed asks and owned lanes, titles only, oldest first', async () => {
      const { db, team, nick, ada, bob } = await seed();
      await msg(db, team, bob, ada, 'ask', 'q1', 500, {
        body: 'can you review #12?\nsecond line never shows',
        meta: { species: 'consult', tier: 'advisory' },
      });
      await msg(db, team, nick, ada, 'request_help', 'r1', 600, { body: 'help with the plist' });
      await msg(db, team, nick, ada, 'ask', 'q2', 700, {
        body: 'answered one',
        meta: { species: 'consult', tier: 'advisory' },
      });
      await msg(db, team, ada, nick, 'accept', 'a2', 701, {
        thread: 'q2',
        meta: { in_reply_to: 'q2' },
      }); // q2 is answered
      const lane = await openLane(db, team.id, team.slug, ada.name, {
        title: 'My lane',
        claim: true,
      });
      const { context } = await deriveContext(db, team, ada, {});
      expect(context.open.map((o) => [o.kind, o.id, o.from])).toEqual([
        ['ask', 'q1', 'bob'],
        ['request_help', 'r1', 'nick'],
        ['lane', lane.id, undefined],
      ]);
      expect(context.open[0]?.title).toBe('can you review #12?');
      for (const o of context.open) expect(o.title.length).toBeLessThanOrEqual(120);
    });

    it('classifies a review ask and a handoff by their meta', async () => {
      const { db, team, nick, ada } = await seed();
      const lane = await openLane(db, team.id, team.slug, nick.name, { title: 'Theirs' });
      await msg(db, team, nick, ada, 'ask', 'rv', 500, {
        meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
      });
      await msg(db, team, nick, ada, 'handoff', 'ho', 600, {
        meta: { lane_handoff: { lane: lane.id } },
      });
      const { context } = await deriveContext(db, team, ada, {});
      expect(context.open.map((o) => o.kind)).toEqual(['review', 'handoff']);
    });

    it("carries the lane detail and the recipient's own last status_update naming it", async () => {
      const { db, team, ada } = await seed();
      const lane = await openLane(db, team.id, team.slug, ada.name, {
        title: 'Lane',
        detail: 'ACCEPTANCE: x',
        claim: true,
      });
      await msg(db, team, ada, null, 'status_update', 's1', 900, {
        body: `on ${lane.id}: halfway`,
      });
      await msg(db, team, ada, null, 'status_update', 's2', 950, { body: 'unrelated' });
      const { context } = await deriveContext(db, team, ada, { laneId: lane.id });
      expect(context.lane).toEqual({
        detail: 'ACCEPTANCE: x',
        truncated: false,
        last_status_update: { ts: 900, body: `on ${lane.id}: halfway`, truncated: false },
      });
    });

    it('carries the memory body whole when it fits, else the first 3 KiB flagged and named in fetch', async () => {
      const { db, team, ada } = await seed();
      await saveMemory(db, ada.id, { headline: 'short', body: 'carrying nothing' });
      expect((await deriveContext(db, team, ada, {})).context.memory).toEqual({
        body: 'carrying nothing',
        truncated: false,
      });
      await saveMemory(db, ada.id, { headline: 'long', body: 'z'.repeat(5_000) });
      const { context, fetch } = await deriveContext(db, team, ada, {});
      expect(context.memory?.truncated).toBe(true);
      expect(Buffer.byteLength(context.memory!.body, 'utf8')).toBeLessThanOrEqual(
        WAKE_CONTEXT_BUDGET.memory,
      );
      expect(fetch).toContain('seat_memory');
    });

    it('never exceeds the 12 KiB cap and names what it dropped', async () => {
      const { db, team, nick, ada, bob } = await seed();
      await saveMemory(db, ada.id, { headline: 'h', body: 'm'.repeat(3_000) });
      await msg(db, team, nick, ada, 'message', 'b0', 1_000, { body: 'b'.repeat(600) });
      for (let i = 1; i <= 8; i++)
        await msg(db, team, nick, ada, 'message', `b${i}`, 1_000 + i, {
          thread: 'b0',
          body: 'b'.repeat(600),
        });
      for (let i = 0; i < 40; i++)
        await msg(db, team, bob, ada, 'ask', `o${i}`, 2_000 + i, {
          body: 'o'.repeat(120),
          meta: { species: 'consult', tier: 'advisory' },
        });
      const { context, used_bytes, fetch } = await deriveContext(db, team, ada, { threadId: 'b0' });
      expect(used_bytes).toBeLessThanOrEqual(WAKE_CONTEXT_BUDGET.limit_bytes);
      expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBe(used_bytes);
      expect(context.thread?.acts.length).toBeGreaterThan(0);
      expect(context.open.length).toBeLessThanOrEqual(WAKE_CONTEXT_BUDGET.open_items);
      expect(fetch).toContain('open_items');
    });
  });
});
