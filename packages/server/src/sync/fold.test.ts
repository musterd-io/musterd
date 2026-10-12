import { makeEnvelope, type SyncPullEvent } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { type Database } from '../db/open.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';
import { foldBatch, foldNodeLiveness, readPullCursor } from './fold.js';

withDrivers('fold', (_o, kind) => {
  /**
   * The fold (3b-ii) — the second insert path ADR 331 §Consequences warned about, built once and
   * falsified here. The first test is the falsifier: folding foreign events must not move this
   * daemon's own allocator.
   */

  const FOREIGN = '01FOREIGNNODE00000000000000';

  async function seed() {
    const db = await openTestDriver(kind);
    const team = await createTeam(db, { slug: 'revive' });
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    // One local message so the local node row exists and has handed out one seq.
    await insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: 'local-1',
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' },
        act: 'message',
        body: 'hi',
        ts: 1000,
      }),
    );
    // messages.origin_node carries no FK (v47 ALTER) but sync_log.origin_node does; a nodes row for
    // the foreign origin lets a later test stage through ingestBatch if it wants to.
    await db.run('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)', [
      FOREIGN,
      team.id,
      'foreign',
    ]);
    return { db, team, ada, nick };
  }

  async function localNextSeq(db: Database, teamId: string): Promise<number> {
    return (await db.get(
      'SELECT n.next_seq FROM nodes n JOIN local_node l ON l.node_id = n.id WHERE l.team_id = ?',
      [teamId],
    ))!.next_seq;
  }

  async function foreign(
    id: string,
    seq: number,
    hubSeq: number,
    overrides: Partial<{
      from: string;
      to: { kind: 'member'; name: string } | { kind: 'team' };
      act: string;
      ts: number;
    }> = {},
  ): Promise<SyncPullEvent> {
    const envelope = makeEnvelope({
      id,
      team: 'revive',
      from: overrides.from ?? 'nick',
      to: overrides.to ?? { kind: 'team' },
      act: 'message',
      body: `b-${seq}`,
      ts: overrides.ts ?? 2000 + seq,
    });
    // makeEnvelope validates the act; an origin on a NEWER build would mint one this build's enum
    // refuses, so the override goes on after the parse — that is what "the wire outran the reader"
    // looks like from here.
    if (overrides.act) (envelope as { act: string }).act = overrides.act;
    return {
      envelope,
      origin_node: FOREIGN,
      origin_seq: seq,
      from_provenance: 'session',
      hub_seq: hubSeq,
    };
  }

  describe('foldBatch', async () => {
    it('never moves the local allocator (the ADR 331 falsifier)', async () => {
      const { db, team } = await seed();
      const before = await localNextSeq(db, team.id);
      const res = await foldBatch(db, team.id, [
        await foreign('f-1', 1, 1),
        await foreign('f-2', 2, 2),
        await foreign('f-3', 3, 3),
      ]);
      expect(res).toMatchObject({ applied: 3, skipped: 0, last_hub_seq: 3, stop: null });
      expect(await localNextSeq(db, team.id)).toBe(before);
      const rows = await db.all(
        'SELECT id, origin_node, origin_seq, from_provenance FROM messages WHERE origin_node = ? ORDER BY origin_seq',
        [FOREIGN],
      );
      expect(rows).toEqual([
        { id: 'f-1', origin_node: FOREIGN, origin_seq: 1, from_provenance: 'session' },
        { id: 'f-2', origin_node: FOREIGN, origin_seq: 2, from_provenance: 'session' },
        { id: 'f-3', origin_node: FOREIGN, origin_seq: 3, from_provenance: 'session' },
      ]);
      expect(await readPullCursor(db, team.id)).toBe(3);
      await db.close();
    });

    it("resolves from/to by NAME to this daemon's member ids", async () => {
      const { db, team, nick, ada } = await seed();
      await foldBatch(db, team.id, [
        await foreign('f-1', 1, 1, { from: 'nick', to: { kind: 'member', name: 'ada' } }),
      ]);
      const row = await db.get(
        'SELECT from_member, to_member, to_kind FROM messages WHERE id = ?',
        ['f-1'],
      )!;
      expect(row).toEqual({ from_member: nick.id, to_member: ada.id, to_kind: 'member' });
      await db.close();
    });

    it("stamps created_at with the fold's own clock, never the envelope's ts", async () => {
      // Spec §"The ts-cursor defect": the readers moving off ts land on created_at, so a wire value
      // here would reintroduce the defect under the fixed column. ts travels; created_at does not.
      const { db, team } = await seed();
      const now = 9_000_000;
      await foldBatch(db, team.id, [await foreign('f-1', 1, 1, { ts: 12 })], now);
      const row = await db.get('SELECT ts, created_at FROM messages WHERE id = ?', ['f-1'])!;
      expect(row).toEqual({ ts: 12, created_at: now });
      await db.close();
    });

    it('skips its own origin — already in messages via insertMessage', async () => {
      const { db, team } = await seed();
      const local = (await db.get('SELECT node_id FROM local_node WHERE team_id = ?', [team.id]))!
        .node_id;
      const own: SyncPullEvent = { ...(await foreign('local-1', 1, 7)), origin_node: local };
      const res = await foldBatch(db, team.id, [own]);
      expect(res).toMatchObject({ applied: 0, skipped: 1, last_hub_seq: 7, stop: null });
      expect(await db.get('SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 1 });
      await db.close();
    });

    it('skips its own origin even when nothing local holds that (origin, seq) — Rule 1 on its own', async () => {
      // The test above passes with Rule 1 deleted: seq 1 IS already in messages, so Rule 2 (the
      // idempotence check) skips it first and masks the missing rule. An own-origin event with a seq
      // this daemon never allocated is the one only Rule 1 catches — and it must still be skipped,
      // because applying it would write a row under OUR origin stamp that WE never sent (dolly, #1155
      // review F2).
      const { db, team } = await seed();
      const local = (await db.get('SELECT node_id FROM local_node WHERE team_id = ?', [team.id]))!
        .node_id;
      const own: SyncPullEvent = { ...(await foreign('local-99', 99, 7)), origin_node: local };
      const res = await foldBatch(db, team.id, [own]);
      expect(res).toMatchObject({ applied: 0, skipped: 1, last_hub_seq: 7, stop: null });
      expect(await db.get('SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 1 });
      await db.close();
    });

    it('is idempotent on (origin_node, origin_seq) — a replay applies nothing and advances the cursor', async () => {
      const { db, team } = await seed();
      await foldBatch(db, team.id, [await foreign('f-1', 1, 1)]);
      const res = await foldBatch(db, team.id, [
        await foreign('f-1', 1, 1),
        await foreign('f-2', 2, 2),
      ]);
      expect(res).toMatchObject({ applied: 1, skipped: 1, last_hub_seq: 2, stop: null });
      await db.close();
    });

    it('blocks at an unresolvable FROM: prefix applied, cursor at the blocker, nothing after', async () => {
      const { db, team } = await seed();
      const res = await foldBatch(db, team.id, [
        await foreign('f-1', 1, 1),
        await foreign('f-2', 2, 2, { from: 'ghost' }),
        await foreign('f-3', 3, 3),
      ]);
      expect(res).toMatchObject({
        applied: 1,
        skipped: 0,
        last_hub_seq: 1,
        stop: { kind: 'unresolved_seat', seat: 'ghost', hub_seq: 2 },
      });
      expect(
        await db.get('SELECT COUNT(*) AS n FROM messages WHERE origin_node = ?', [FOREIGN]),
      ).toEqual({ n: 1 });
      expect(await readPullCursor(db, team.id)).toBe(1);
      await db.close();
    });

    it('blocks at an unresolvable TO — a directed act never silently becomes a broadcast', async () => {
      const { db, team } = await seed();
      const res = await foldBatch(db, team.id, [
        await foreign('f-1', 1, 1, { to: { kind: 'member', name: 'ghost' } }),
      ]);
      expect(res.stop).toEqual({ kind: 'unresolved_seat', seat: 'ghost', hub_seq: 1 });
      expect(res.applied).toBe(0);
      expect(await readPullCursor(db, team.id)).toBe(0);
      await db.close();
    });

    it('resumes past a blocker once the roster knows the seat', async () => {
      const { db, team } = await seed();
      const batch = [await foreign('f-1', 1, 1, { from: 'late' })];
      expect((await foldBatch(db, team.id, batch)).stop?.kind).toBe('unresolved_seat');
      await addMember(db, team, { name: 'late', kind: 'agent' });
      expect(await foldBatch(db, team.id, batch)).toMatchObject({
        applied: 1,
        skipped: 0,
        last_hub_seq: 1,
        stop: null,
      });
      await db.close();
    });

    it('advances the cursor in the same transaction as the applied rows', async () => {
      const { db, team } = await seed();
      // An act this build's CHECK refuses on the second event: a classified STOP, not a throw, so
      // the prefix and the cursor commit together.
      const res = await foldBatch(db, team.id, [
        await foreign('f-1', 1, 1),
        await foreign('f-2', 2, 2, { act: 'not-an-act' }),
      ]);
      expect(res.stop).toEqual({ kind: 'unknown_act', act: 'not-an-act', hub_seq: 2 });
      expect(res.applied).toBe(1);
      expect(await readPullCursor(db, team.id)).toBe(1);
      await db.close();
    });

    it('treats an envelope id already held under a DIFFERENT origin pair as terminal', async () => {
      const { db, team } = await seed();
      // 'local-1' exists under the local origin; a foreign event reusing that id is rule 5.
      const res = await foldBatch(db, team.id, [await foreign('local-1', 1, 1)]);
      expect(res.stop?.kind).toBe('id_collision');
      expect((res.stop as { held_origin: string }).held_origin).not.toBe(FOREIGN);
      expect(res.applied).toBe(0);
      await db.close();
    });

    it('refuses an origin gap on the read side', async () => {
      const { db, team } = await seed();
      const res = await foldBatch(db, team.id, [
        await foreign('f-1', 1, 1),
        await foreign('f-3', 3, 2),
      ]);
      expect(res.stop).toEqual({
        kind: 'origin_gap',
        origin: FOREIGN,
        expected: 2,
        got: 3,
        hub_seq: 2,
      });
      expect(res.applied).toBe(1);
      expect(await readPullCursor(db, team.id)).toBe(1);
      await db.close();
    });
  });

  /** A replicated `lane.*` row from the foreign origin (lane-replication spec §"The wire, decided"). */
  function foreignLane(
    id: string,
    seq: number,
    hubSeq: number,
    action: string,
    detail: Record<string, unknown>,
    ts = 3000 + seq,
  ): SyncPullEvent {
    return {
      kind: 'lane',
      team: 'revive',
      event: {
        id,
        ts,
        actor: 'nick',
        action,
        target: (detail['lane'] as string) ?? null,
        result: 'allow',
        detail,
      },
      origin_node: FOREIGN,
      origin_seq: seq,
      hub_seq: hubSeq,
    };
  }

  describe('foldBatch — the lane kind', async () => {
    it('projects a birth into lanes, holds the row in audit with its stamp, and leaves the allocator alone', async () => {
      const { db, team } = await seed();
      const before = await localNextSeq(db, team.id);
      const res = await foldBatch(db, team.id, [
        foreignLane('e-1', 1, 1, 'lane.opened', {
          lane: 'L1',
          title: 'from afar',
          project: 'musterd',
          scope: ['a/**'],
          stakes: 'high',
          created_by: 'nick',
          created_at: 5,
        }),
        foreignLane('e-2', 2, 2, 'lane.claimed', { lane: 'L1', owner: 'nick', kind: 'claim' }),
      ]);
      expect(res).toMatchObject({ applied: 2, skipped: 0, last_hub_seq: 2, stop: null });
      expect(await localNextSeq(db, team.id)).toBe(before);
      expect(
        await db.get(
          'SELECT title, project, surface_globs, stakes, owner_seat, state, created_at FROM lanes WHERE id = ?',
          ['L1'],
        ),
      ).toEqual({
        title: 'from afar',
        project: 'musterd',
        surface_globs: '["a/**"]',
        stakes: 'high',
        owner_seat: 'nick',
        state: 'claimed',
        created_at: 5,
      });
      expect(
        await db.all(
          'SELECT id, origin_node, origin_seq FROM audit WHERE origin_node = ? ORDER BY origin_seq',
          [FOREIGN],
        ),
      ).toEqual([
        { id: 'e-1', origin_node: FOREIGN, origin_seq: 1 },
        { id: 'e-2', origin_node: FOREIGN, origin_seq: 2 },
      ]);
      await db.close();
    });

    it('carries source_ref on a birth and an update, and never refuses a duplicate (ADR 561)', async () => {
      const { db, team } = await seed();
      // A local open lane already holds the ref; the fold applies history and does not judge it —
      // the one-open-lane-per-ref check lives at each daemon's own write.
      await db.run(
        `INSERT INTO lanes (id, team_id, project, title, surface_globs, depends_on, state, source_ref,
                            created_by, created_at, updated_at)
         VALUES ('L0', ?, 'default', 'local', '[]', '[]', 'open', 'acme/app#1', 'ada', 1, 1)`,
        [team.id],
      );
      const res = await foldBatch(db, team.id, [
        foreignLane('e-1', 1, 1, 'lane.opened', {
          lane: 'L1',
          title: 'from afar',
          source_ref: 'acme/app#1',
        }),
        foreignLane('e-2', 2, 2, 'lane.opened', { lane: 'L2', title: 'no ref' }),
        foreignLane('e-3', 3, 3, 'lane.updated', {
          lane: 'L2',
          changes: { source_ref: { from: null, to: 'ENG-7' } },
        }),
      ]);
      expect(res).toMatchObject({ applied: 3, skipped: 0, stop: null });
      expect(
        await db.all('SELECT id, source_ref FROM lanes WHERE team_id = ? ORDER BY id', [team.id]),
      ).toEqual([
        { id: 'L0', source_ref: 'acme/app#1' },
        { id: 'L1', source_ref: 'acme/app#1' },
        { id: 'L2', source_ref: 'ENG-7' },
      ]);
      await db.close();
    });

    it('blocks on a verb it cannot project — the wire outran the reader', async () => {
      const { db, team } = await seed();
      const res = await foldBatch(db, team.id, [
        foreignLane('e-1', 1, 1, 'lane.opened', { lane: 'L1', title: 't' }),
        foreignLane('e-2', 2, 2, 'lane.teleported', { lane: 'L1' }),
      ]);
      expect(res.applied).toBe(1);
      expect(res.stop).toEqual({
        kind: 'unknown_lane_event',
        action: 'lane.teleported',
        hub_seq: 2,
      });
      expect(await readPullCursor(db, team.id)).toBe(1);
      await db.close();
    });

    it('blocks on a transition for a lane it never saw born, before the row lands in audit', async () => {
      const { db, team } = await seed();
      const res = await foldBatch(db, team.id, [
        foreignLane('e-1', 1, 1, 'lane.claimed', { lane: 'GHOST', owner: 'nick', kind: 'claim' }),
      ]);
      expect(res.stop).toEqual({
        kind: 'lane_unborn',
        lane: 'GHOST',
        action: 'lane.claimed',
        hub_seq: 1,
      });
      expect(
        await db.get('SELECT COUNT(*) AS n FROM audit WHERE origin_node = ?', [FOREIGN]),
      ).toEqual({ n: 0 });
      expect(await db.get('SELECT COUNT(*) AS n FROM lanes WHERE id = ?', ['GHOST'])).toEqual({
        n: 0,
      });
      await db.close();
    });

    it('a submit that arrives after the close never reopens the lane (2026-10-05: three lanes stuck awaiting_acceptance)', async () => {
      // The joiner wrote `lane.ready_for_review` at 1000; the close at 2000 reached this daemon first
      // and the submit row folded afterwards. Applied blindly it put state back to
      // awaiting_acceptance while resolved_at stayed set.
      const { db, team } = await seed();
      const res = await foldBatch(db, team.id, [
        foreignLane('e-1', 1, 1, 'lane.opened', { lane: 'L1', title: 't' }, 500),
        foreignLane('e-2', 2, 2, 'lane.claimed', { lane: 'L1', owner: 'nick', kind: 'claim' }, 600),
        foreignLane('e-3', 3, 3, 'lane.closed', { lane: 'L1', state: 'done' }, 2000),
        foreignLane('e-4', 4, 4, 'lane.ready_for_review', { lane: 'L1', owner: 'nick' }, 1000),
        foreignLane(
          'e-5',
          5,
          5,
          'lane.state_changed',
          { lane: 'L1', from: 'active', to: 'awaiting_acceptance' },
          999,
        ),
      ]);
      expect(res).toMatchObject({ applied: 5, stop: null });
      expect(
        await db.get('SELECT state, resolved_at, updated_at FROM lanes WHERE id = ?', ['L1']),
      ).toEqual({ state: 'done', resolved_at: 2000, updated_at: 2000 });
      // The rows are still held in audit: history keeps them, only the projection ignores them.
      expect(
        await db.get('SELECT COUNT(*) AS n FROM audit WHERE origin_node = ?', [FOREIGN]),
      ).toEqual({ n: 5 });
      await db.close();
    });

    it('a reopen made after the close still applies', async () => {
      const { db, team } = await seed();
      await foldBatch(db, team.id, [
        foreignLane('e-1', 1, 1, 'lane.opened', { lane: 'L1', title: 't' }, 500),
        foreignLane('e-2', 2, 2, 'lane.closed', { lane: 'L1', state: 'done' }, 2000),
        foreignLane(
          'e-3',
          3,
          3,
          'lane.state_changed',
          { lane: 'L1', from: 'done', to: 'active' },
          3000,
        ),
      ]);
      expect(await db.get('SELECT state FROM lanes WHERE id = ?', ['L1'])).toEqual({
        state: 'active',
      });
      await db.close();
    });

    it('a message and a lane row from one origin share one dense sequence — no gap between kinds', async () => {
      const { db, team } = await seed();
      const res = await foldBatch(db, team.id, [
        await foreign('f-1', 1, 1),
        foreignLane('e-2', 2, 2, 'lane.opened', { lane: 'L1', title: 't' }),
        await foreign('f-3', 3, 3),
      ]);
      expect(res).toMatchObject({ applied: 3, skipped: 0, last_hub_seq: 3, stop: null });
      await db.close();
    });
  });

  /** A replicated `presence.*` row from the foreign origin (presence replication, 2026-09-02). */
  function foreignPresence(
    id: string,
    seq: number,
    hubSeq: number,
    action: string,
    detail: Record<string, unknown>,
    actor = 'ada',
  ): SyncPullEvent {
    return {
      kind: 'presence',
      team: 'revive',
      event: { id, ts: 4000 + seq, actor, action, target: actor, result: 'allow', detail },
      origin_node: FOREIGN,
      origin_seq: seq,
      hub_seq: hubSeq,
    };
  }

  describe('foldBatch — the presence kind', async () => {
    it('presence.attached carries style_epoch onto the remote row, and reattested moves it (ADR 514)', async () => {
      const { db, team } = await seed();
      const att = foreignPresence('p-1', 1, 1, 'presence.attached', {
        presence: 'pS',
        surface: 'codex',
        model: 'gpt-5',
        model_source: 'observed',
        workspace: '~/s',
        driver: 'nick',
        provenance: 'session',
        build: null,
        epoch: 17,
        style_epoch: 'a1b2c3d4',
      });
      expect((await foldBatch(db, team.id, [att])).stop).toBeNull();
      expect(await db.get("SELECT style_epoch FROM presence WHERE id = 'pS'")).toEqual({
        style_epoch: 'a1b2c3d4',
      });
      const re = foreignPresence('p-2', 2, 2, 'presence.reattested', {
        presence: 'pS',
        model: 'gpt-5',
        model_source: 'observed',
        surface: 'codex',
        style_epoch: 'ffffffff',
      });
      expect((await foldBatch(db, team.id, [re])).stop).toBeNull();
      expect(await db.get("SELECT style_epoch FROM presence WHERE id = 'pS'")).toEqual({
        style_epoch: 'ffffffff',
      });
    });

    it('presence.attached inserts a remote row keyed on the origin node; reattested updates it; detached deletes it', async () => {
      const { db, team } = await seed();
      const att = foreignPresence('p-1', 1, 1, 'presence.attached', {
        presence: 'pB',
        surface: 'codex',
        model: 'gpt-5',
        model_source: 'observed',
        workspace: '~/b',
        driver: 'nick',
        provenance: 'session',
        build: null,
        epoch: 17,
      });
      expect((await foldBatch(db, team.id, [att])).stop).toBeNull();
      expect(
        await db.get(
          "SELECT node, surface, model, workspace, driver, conn_id, held_until, wake_lease FROM presence WHERE id = 'pB'",
        ),
      ).toEqual({
        node: FOREIGN,
        surface: 'codex',
        model: 'gpt-5',
        workspace: '~/b',
        driver: 'nick',
        conn_id: null,
        held_until: null,
        wake_lease: null,
      });
      const re = foreignPresence('p-2', 2, 2, 'presence.reattested', {
        presence: 'pB',
        model: 'gpt-5-mini',
        model_source: 'observed',
        surface: 'codex',
      });
      expect((await foldBatch(db, team.id, [re])).stop).toBeNull();
      expect(await db.get("SELECT model FROM presence WHERE id = 'pB'")).toEqual({
        model: 'gpt-5-mini',
      });
      const det = foreignPresence('p-3', 3, 3, 'presence.detached', {
        presence: 'pB',
        reason: 'goodbye',
      });
      expect((await foldBatch(db, team.id, [det])).stop).toBeNull();
      expect(await db.get("SELECT COUNT(*) AS n FROM presence WHERE id = 'pB'")).toEqual({
        n: 0,
      });
      expect(
        await db.get(
          "SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'presence.%' AND origin_node = ?",
          [FOREIGN],
        ),
      ).toEqual({ n: 3 });
      // The allocator never moved for any of it.
      expect(await localNextSeq(db, team.id)).toBe(2);
      await db.close();
    });

    // Until ADR 384 the reattest half of this stopped as `presence_unborn`. It cannot: the row it
    // waits for is one this daemon's own reaper takes during a long replay, so the wait never ends —
    // it wedged the first real joiner at hub_seq 9659 with hundreds of sessions queued behind it.
    // Both halves now advance, and neither invents a row from a partial fact.
    it('a reattested for a session never seen attach advances like the detached for one, inventing no row', async () => {
      const { db, team } = await seed();
      const det = foreignPresence('p-1', 1, 1, 'presence.detached', {
        presence: 'ghost',
        reason: 'reaped',
      });
      expect(await foldBatch(db, team.id, [det])).toMatchObject({
        stop: null,
        applied: 1,
        last_hub_seq: 1,
      });
      const re = foreignPresence('p-2', 2, 2, 'presence.reattested', {
        presence: 'ghost',
        model: 'x',
        model_source: null,
        surface: 'codex',
      });
      expect(await foldBatch(db, team.id, [re])).toMatchObject({
        stop: null,
        applied: 1,
        last_hub_seq: 2,
      });
      expect(await db.get("SELECT COUNT(*) AS n FROM audit WHERE id = 'p-2'")).toEqual({ n: 1 });
      expect(await db.get("SELECT COUNT(*) AS n FROM presence WHERE id = 'ghost'")).toEqual({
        n: 0,
      });
      expect(await readPullCursor(db, team.id)).toBe(2);
      await db.close();
    });

    it('an unknown presence verb or a surface this build cannot store stops as unknown_presence_event', async () => {
      const { db, team } = await seed();
      const weird = foreignPresence('p-1', 1, 1, 'presence.attached', {
        presence: 'p',
        surface: 'holodeck',
      });
      expect((await foldBatch(db, team.id, [weird])).stop).toMatchObject({
        kind: 'unknown_presence_event',
      });
      const verb = foreignPresence('p-1', 1, 1, 'presence.teleported', { presence: 'p' });
      expect((await foldBatch(db, team.id, [verb])).stop).toMatchObject({
        kind: 'unknown_presence_event',
      });
      await db.close();
    });

    // Until ADR 382 this stopped as `unresolved_seat`, like a message. It cannot: a seat minted
    // db-only — a web sign-in — is never in git, so the wait never ends, and one wedged the first
    // real joiner permanently. Presence for a seat we do not hold projects into nothing, so it
    // advances with its audit row. The message half of the old rule is unchanged and is asserted by
    // its own test above; the two-daemon control lives in `sync/presence.test.ts`.
    it('a presence for a seat this roster lacks advances with its audit row, unlike a message', async () => {
      const { db, team } = await seed();
      const ev = foreignPresence(
        'p-1',
        1,
        1,
        'presence.attached',
        { presence: 'p', surface: 'codex' },
        'stranger',
      );
      const result = await foldBatch(db, team.id, [ev]);
      expect(result.stop).toBeNull();
      expect(result.applied).toBe(1);
      expect(await db.get("SELECT COUNT(*) AS n FROM audit WHERE id = 'p-1'")).toEqual({ n: 1 });
      expect(await db.get("SELECT COUNT(*) AS n FROM presence WHERE id = 'p'")).toEqual({ n: 0 });
      await db.close();
    });

    it('foldNodeLiveness upserts foreign nodes without touching the local allocator', async () => {
      const { db, team } = await seed();
      const localNode = (await db.get('SELECT node_id FROM local_node WHERE team_id = ?', [
        team.id,
      ]))!.node_id;
      await db.run('UPDATE nodes SET next_seq = 7 WHERE id = ?', [localNode]);
      await foldNodeLiveness(db, team.id, [
        { id: localNode, label: 'me', last_seen_at: 1 },
        { id: 'nB', label: 'b', last_seen_at: 2 },
      ]);
      expect(await db.get('SELECT next_seq FROM nodes WHERE id = ?', [localNode])).toEqual({
        next_seq: 7,
      });
      expect(await db.get("SELECT label, last_seen_at FROM nodes WHERE id = 'nB'")).toEqual({
        label: 'b',
        last_seen_at: 2,
      });
      await db.close();
    });
  });
});
