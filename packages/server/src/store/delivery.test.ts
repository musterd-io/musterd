import { makeEnvelope, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit } from './audit.js';
import { setCursor } from './cursors.js';
import {
  actDelivery,
  crossedBySeen,
  handoffNamedLaneOutOfPlay,
  openDirectedLedger,
} from './delivery.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { countOpenLoops, insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('delivery', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
    const bob = (await addMember(db, team, { name: 'bob', kind: 'agent' })).row;
    // These fixtures stamp messages with fake receipt times near zero. A seat is owed only what arrived
    // after it existed (ADR 549), so the members must predate them too.
    await db.run('UPDATE members SET created_at = 0 WHERE team_id = ?', [team.id]);
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
      // Receipt order IS the fixture's order: the cursor walks created_at, so stamp it with the ts.
      { now: ts },
    );
  }

  describe('actDelivery (ADR 090: the per-act ledger, derived)', async () => {
    it('walks logged → seen → answered off the log + cursor, keyed on the normalized seat id', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);

      // Unseen: cursor never advanced.
      let d = (await actDelivery(db, team.id, 'h1', 10_000))!;
      expect(d.recipients).toHaveLength(1);
      expect(d.recipients[0]).toMatchObject({
        seat: 'Ada',
        seat_id: 'ada',
        state: 'logged',
        seen_by: null,
        answered: null,
      });
      expect(d.age_ms).toBe(9_000);

      // Seen: ada's cursor crosses the act (watermark semantics — seen_by is the cursor update time).
      await setCursor(db, ada.id, 'h1');
      d = (await actDelivery(db, team.id, 'h1', 10_000))!;
      expect(d.recipients[0]!.state).toBe('seen');
      expect(d.recipients[0]!.seen_by).not.toBeNull();

      // Answered: ada's accept names the act via meta.in_reply_to.
      await msg(db, team, ada, nick, 'accept', 'a1', 2_000, { meta: { in_reply_to: 'h1' } });
      d = (await actDelivery(db, team.id, 'h1', 10_000))!;
      expect(d.recipients[0]!.state).toBe('answered');
      expect(d.recipients[0]!.answered).toMatchObject({ act: 'accept', id: 'a1', ts: 2_000 });
    });

    /**
     * A read cursor is a `(ts, id)` point, not a ts (ADR 290's 2026-08-20 amendment)). `seen` compared
     * on ts alone with `>=`, so an act sharing the cursor row's millisecond reported as SEEN although
     * the reader was never handed it — while `listInbox` reports that same act UNREAD. One message,
     * both at once, and `seen` is the answer the ADR 090 ledger exists to give.
     */
    it('an act tied with the cursor row is not seen — the reader was never handed it', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      await msg(db, team, nick, ada, 'handoff', 'h2', 1_000); // same millisecond, never delivered

      await setCursor(db, ada.id, 'h1'); // ada read h1, and only h1

      expect((await actDelivery(db, team.id, 'h1', 10_000))!.recipients[0]!.state).toBe('seen');
      const tied = (await actDelivery(db, team.id, 'h2', 10_000))!.recipients[0]!;
      expect(tied.state).toBe('logged');
      expect(tied.seen_by).toBeNull();
    });

    it('a resolve on the thread answers for every recipient', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, null, 'request_help', 'r1', 1_000, { thread: 't1' });
      await msg(db, team, ada, null, 'resolve', 'v1', 3_000, { thread: 't1' });
      const d = (await actDelivery(db, team.id, 'r1', 10_000))!;
      // Team act fans out to the current roster minus the sender.
      expect(d.recipients.map((r) => r.seat).sort()).toEqual(['Ada', 'bob']);
      for (const r of d.recipients) expect(r.state).toBe('answered');
      expect(d.recipients[0]!.answered).toMatchObject({ act: 'resolve', id: 'v1' });
    });

    it('counts ADR 088 interrupt raises from the audit as attempt history, and reads meta.urgent', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h2', 1_000, {
        meta: { urgent: true, urgent_reason: 'steer' },
      });
      await appendAudit(db, team.id, {
        actor: 'nick',
        action: 'interrupt.raised',
        target: 'Ada',
        result: 'allow',
        detail: { act: 'h2', act_kind: 'handoff', tier: 'urgent', count: 1 },
      });
      const d = (await actDelivery(db, team.id, 'h2', 5_000))!;
      expect(d.urgent).toBe(true);
      expect(d.recipients[0]!.interrupt_raises).toBe(1);
    });

    it('returns null for an unknown id', async () => {
      const { db, team } = await seed();
      expect(await actDelivery(db, team.id, 'nope')).toBeNull();
    });
  });

  describe('crossedBySeen (ADR 090: the seen_latency scope)', async () => {
    it('covers directed acts AND team/broadcast loop-opening acts, never my own sends or chatter', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000); // directed at ada → counts
      await msg(db, team, nick, null, 'request_help', 'r1', 2_000); // team loop-opening (to_member NULL) → counts
      await msg(db, team, nick, null, 'status_update', 's1', 3_000); // team chatter → not the firehose
      await msg(db, team, ada, null, 'request_help', 'r2', 4_000); // ada's own send → excluded

      const crossed = await crossedBySeen(db, team.id, ada.id, 0, 10_000);
      expect(crossed.map((c) => c.act).sort()).toEqual(['handoff', 'request_help']);
    });

    it('is bounded by the cursor window (fromTs exclusive, toTs inclusive)', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      await msg(db, team, nick, ada, 'handoff', 'h2', 2_000);
      expect((await crossedBySeen(db, team.id, ada.id, 1_000, 2_000)).map((c) => c.ts)).toEqual([
        2_000,
      ]);
    });
  });

  describe('openDirectedLedger (ADR 090: the open directed ledger)', async () => {
    it('lists loop-opening acts until answered — accept and resolve both close', async () => {
      const { db, team, nick, ada, bob } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      await msg(db, team, nick, null, 'request_help', 'r1', 2_000, { thread: 't1' });
      expect((await openDirectedLedger(db, team.id, 10_000)).map((d) => d.id)).toEqual([
        'h1',
        'r1',
      ]);

      await msg(db, team, ada, nick, 'accept', 'a1', 3_000, { meta: { in_reply_to: 'h1' } });
      expect((await openDirectedLedger(db, team.id, 10_000)).map((d) => d.id)).toEqual(['r1']);

      await msg(db, team, bob, null, 'resolve', 'v1', 4_000, { thread: 't1' });
      expect(await openDirectedLedger(db, team.id, 10_000)).toHaveLength(0);
    });

    it('includes urgent directed acts of any act type, but not ordinary chatter', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'message', 'm1', 1_000, {
        meta: { urgent: true, urgent_reason: 'steer' },
      });
      await msg(db, team, nick, ada, 'message', 'm2', 2_000); // not urgent, not loop-opening
      expect((await openDirectedLedger(db, team.id, 10_000)).map((d) => d.id)).toEqual(['m1']);
    });

    it('reconciles with the open_loops gauge — two derivations of one truth (the ADR guard)', async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      await msg(db, team, nick, null, 'request_help', 'r1', 2_000, { thread: 't1' });
      const loopActs = async () =>
        (await openDirectedLedger(db, team.id, 10_000)).filter((d) =>
          ['request_help', 'handoff'].includes(d.act),
        ).length;
      expect(await loopActs()).toBe(await countOpenLoops(db));

      await msg(db, team, ada, null, 'resolve', 'v1', 3_000, { thread: 't1' });
      expect(await loopActs()).toBe(await countOpenLoops(db));
      expect(await countOpenLoops(db)).toBe(1);
    });
  });

  describe('handoffNamedLaneOutOfPlay (#745 discharge rule, shared with orientation why)', async () => {
    function metaFor(laneId: string): string {
      return JSON.stringify({ lane_handoff: { lane: laneId } });
    }

    it('is false for a bare handoff, a missing lane, and a still-live named lane', async () => {
      const { db, team } = await seed();
      const lane = await openLane(db, team.id, team.slug, 'nick', { title: 'live', claim: true });
      expect(await handoffNamedLaneOutOfPlay(db, team.id, null)).toBe(false);
      expect(await handoffNamedLaneOutOfPlay(db, team.id, '{}')).toBe(false);
      expect(await handoffNamedLaneOutOfPlay(db, team.id, metaFor('no-such-lane'))).toBe(false);
      expect(await handoffNamedLaneOutOfPlay(db, team.id, metaFor(lane.id))).toBe(false);
    });

    it('is true once the named lane is awaiting acceptance or terminal', async () => {
      const { db, team } = await seed();
      const lane = await openLane(db, team.id, team.slug, 'nick', { title: 'handed', claim: true });
      const meta = metaFor(lane.id);
      await updateLane(db, team.id, lane.id, team.slug, { state: 'awaiting_acceptance' });
      expect(await handoffNamedLaneOutOfPlay(db, team.id, meta)).toBe(true);
      await updateLane(db, team.id, lane.id, team.slug, { state: 'done' });
      expect(await handoffNamedLaneOutOfPlay(db, team.id, meta)).toBe(true);
      await updateLane(db, team.id, lane.id, team.slug, { state: 'abandoned' });
      expect(await handoffNamedLaneOutOfPlay(db, team.id, meta)).toBe(true);
    });
  });

  /**
   * ADR 231 (#662, 2026-08-04) made a handoff act name its lane in meta, and every handoff since
   * carries one. The 24 that predate it never will — and because a bare handoff is always "in play",
   * the newest one wins the `why` slot permanently and no future event can retire it. Measured on the
   * live db 2026-08-12: 34 handoffs, 24 bare, 7 of those naming a lane in their BODY, and the oldest
   * still being served as a live instruction 16 days after its lane shipped.
   *
   * A lane id in prose is not prose: it either resolves to a lane row or it does not. Ids are rendered
   * TRUNCATED (`01KYJ8B5AB` for `01KYJ8B5AB9MNZY8T35E2KKTTY`), so this is prefix resolution, and the
   * discipline that makes it a recorded fact rather than a guess is unique resolution — an ambiguous
   * prefix proves nothing and abstains.
   */
  describe('a bare handoff whose BODY names its lane (the pre-ADR-231 population)', async () => {
    it('discharges when every lane the body names has left play', async () => {
      const { db, team } = await seed();
      const lane = await openLane(db, team.id, team.slug, 'nick', {
        title: 'recall arm',
        claim: true,
      });
      const body = `Lane ${lane.id.slice(0, 10)} — ADR 163 recall arm, yours.`;
      expect(await handoffNamedLaneOutOfPlay(db, team.id, null, body)).toBe(false);
      await updateLane(db, team.id, lane.id, team.slug, { state: 'done' });
      expect(await handoffNamedLaneOutOfPlay(db, team.id, null, body)).toBe(true);
    });

    // THE hazard, and the reason this is all-or-nothing. Real handoffs name more than one lane: the
    // one being handed off AND a lane it overlaps or supersedes. Discharging on "some named lane is
    // done" would silence a live handoff because it mentioned a finished one in passing — work
    // dropped on the floor, which this file's own comment calls the unrecoverable direction.
    it('keeps showing when ANY lane the body names is still in play', async () => {
      const { db, team } = await seed();
      const shipped = await openLane(db, team.id, team.slug, 'nick', {
        title: 'shipped',
        claim: true,
      });
      const live = await openLane(db, team.id, team.slug, 'nick', {
        title: 'still going',
        claim: true,
      });
      await updateLane(db, team.id, shipped.id, team.slug, { state: 'done' });
      const body = `Lane ${shipped.id.slice(0, 10)} is yours. Note it overlaps ${live.id.slice(0, 10)}.`;
      expect(await handoffNamedLaneOutOfPlay(db, team.id, null, body)).toBe(false);
    });

    it('abstains on an id-shaped token that resolves to no lane', async () => {
      const { db, team } = await seed();
      expect(await handoffNamedLaneOutOfPlay(db, team.id, null, 'see 01ZZZZZZZZ for context')).toBe(
        false,
      );
    });

    // An ambiguous prefix is not evidence. Two lanes sharing it means the body picked out neither.
    it('abstains when a prefix resolves to more than one lane', async () => {
      const { db, team } = await seed();
      const a = await openLane(db, team.id, team.slug, 'nick', { title: 'a', claim: true });
      const b = await openLane(db, team.id, team.slug, 'nick', { title: 'b', claim: true });
      await updateLane(db, team.id, a.id, team.slug, { state: 'done' });
      await updateLane(db, team.id, b.id, team.slug, { state: 'done' });
      // ULIDs are time-ordered, so two lanes opened in the same millisecond band share a long prefix.
      const shared = a.id.slice(0, 6);
      if (b.id.startsWith(shared)) {
        expect(await handoffNamedLaneOutOfPlay(db, team.id, null, `lane ${shared}`)).toBe(false);
      }
    });

    // Structured meta is the authority when present: it says which lane the handoff IS about, where
    // the body only says which lanes it mentions.
    it('lets structured meta win over the body', async () => {
      const { db, team } = await seed();
      const named = await openLane(db, team.id, team.slug, 'nick', { title: 'named', claim: true });
      const mentioned = await openLane(db, team.id, team.slug, 'nick', {
        title: 'mentioned',
        claim: true,
      });
      await updateLane(db, team.id, mentioned.id, team.slug, { state: 'done' });
      const meta = JSON.stringify({ lane_handoff: { lane: named.id } });
      const body = `see also ${mentioned.id.slice(0, 10)}`;
      expect(await handoffNamedLaneOutOfPlay(db, team.id, meta, body)).toBe(false);
    });

    it('is unchanged when no body is passed at all', async () => {
      const { db, team } = await seed();
      expect(await handoffNamedLaneOutOfPlay(db, team.id, null)).toBe(false);
    });
  });

  describe('the eligible set (ADR 254): obligation narrows, and any one answer discharges', async () => {
    /** await seed() gives nick/Ada/bob; a fourth seat is what distinguishes "the named few" from "everyone". */
    async function seed4() {
      const s = await seed();
      const cy = (await addMember(s.db, s.team, { name: 'cy', kind: 'agent' })).row;
      return { ...s, cy };
    }

    it('is owed by the named seats, not the roster', async () => {
      const { db, team, nick } = await seed4();
      await msg(db, team, nick, null, 'message', 'e1', 1_000, {
        meta: { eligible: ['Ada', 'bob'] },
      });
      const d = (await actDelivery(db, team.id, 'e1', 10_000))!;
      expect(d.recipients.map((r) => r.seat).sort()).toEqual(['Ada', 'bob']);
    });

    it('regression: a plain team act is still owed by the whole roster', async () => {
      const { db, team, nick } = await seed4();
      await msg(db, team, nick, null, 'message', 't1', 1_000);
      const d = (await actDelivery(db, team.id, 't1', 10_000))!;
      expect(d.recipients.map((r) => r.seat).sort()).toEqual(['Ada', 'bob', 'cy']);
    });

    // The load-bearing one. `answerBy` is scoped per recipient (`from_member = recipientId`), so
    // without an any-of clause bob's answer leaves Ada owing forever — the primitive's whole promise
    // ("either of you") would be false at the ledger.
    it('one seat answering discharges it for every eligible seat', async () => {
      const { db, team, nick, bob } = await seed4();
      await msg(db, team, nick, null, 'message', 'e2', 1_000, {
        meta: { eligible: ['Ada', 'bob'] },
      });
      await msg(db, team, bob, nick, 'accept', 'a1', 2_000, { meta: { in_reply_to: 'e2' } });

      const d = (await actDelivery(db, team.id, 'e2', 10_000))!;
      expect(d.recipients.map((r) => r.state)).toEqual(['answered', 'answered']);
      expect(d.recipients.every((r) => r.answered?.id === 'a1')).toBe(true);
    });

    it('regression: on a plain team act, one seat answering does NOT answer for the others', async () => {
      const { db, team, nick, bob } = await seed4();
      await msg(db, team, nick, null, 'request_help', 't2', 1_000);
      await msg(db, team, bob, nick, 'accept', 'a2', 2_000, { meta: { in_reply_to: 't2' } });

      const d = (await actDelivery(db, team.id, 't2', 10_000))!;
      const byName = Object.fromEntries(d.recipients.map((r) => [r.seat, r.state]));
      expect(byName['bob']).toBe('answered');
      expect(byName['Ada']).not.toBe('answered');
    });

    it('names a seat that has since left — the set is pinned in the envelope', async () => {
      const { db, team, nick } = await seed4();
      await msg(db, team, nick, null, 'message', 'e3', 1_000, {
        meta: { eligible: ['Ada', 'bob'] },
      });
      await db.run("UPDATE members SET left_at = 5000 WHERE name = 'bob'");
      const d = (await actDelivery(db, team.id, 'e3', 10_000))!;
      expect(d.recipients.map((r) => r.seat).sort()).toEqual(['Ada', 'bob']);
    });
  });
});
