import { makeEnvelope, type MemberSummary } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { operatorCtx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import type { ChannelBinding } from '../store/channelBindings.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { buildAppRoster } from './appQuickAction.js';

withDrivers('app roster waiting', (_o, kind) => {
  let server: RunningServer;
  let port: number;
  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    port = (await server.listen()).port;
  });
  afterEach(async () => {
    await server.close();
  });

  describe('ADR 806: the roster says who a seat waits on', () => {
    it("carries a seat's oldest open question; none for no question or an answered one", async () => {
      const ctx = operatorCtx({
        db: server.store,
        traceDb: server.traceStore,
        hub: new Hub(),
        config: server.config,
        rosterRoots: [],
      });
      const res = await fetch(`http://127.0.0.1:${port}/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
      });
      expect(res.status).toBe(201);
      const team = (await getTeamBySlug(ctx.db, 'dawn'))!;
      const nick = (await ctx.db.get<{ id: string }>(
        `SELECT id FROM members WHERE team_id = ? AND name = 'nick'`,
        [team.id],
      ))!;
      const [ada, bo, cy] = await Promise.all(
        ['ada', 'bo', 'cy'].map(
          async (name) => (await addMember(ctx.db, team, { name, kind: 'agent' })).row,
        ),
      );
      const ask = (id: string, from: { id: string; name: string }, ts: number, to: string | null) =>
        insertMessage(
          ctx.db,
          team.id,
          from.id,
          to ? nick.id : null,
          makeEnvelope({
            id,
            team: 'dawn',
            from: from.name,
            to: to ? { kind: 'member', name: to } : { kind: 'team' },
            act: 'ask',
            body: '',
            ts,
            meta: {
              species: 'consult',
              question: { text: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
            },
          }),
        );
      // ada: two open questions — the oldest wins.
      await ask('q-ada-1', ada!, 1_000, 'nick');
      await ask('q-ada-2', ada!, 2_000, null);
      // bo: one question, answered.
      await ask('q-bo', bo!, 1_500, 'nick');
      await insertMessage(
        ctx.db,
        team.id,
        nick.id,
        bo!.id,
        makeEnvelope({
          id: 'a-bo',
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'bo' },
          act: 'accept',
          body: '',
          ts: 1_600,
          meta: {
            in_reply_to: 'q-bo',
            answer: { choice: 0 },
            answer_proof: { channel: 'live', verified: true, by: 'nick' },
          },
        }),
      );
      await ctx.db.run(
        `INSERT INTO question_answers (team_id, question_id, answer_id, asker, answered_by, channel, verified, late, answered_at)
         VALUES (?, 'q-bo', 'a-bo', 'bo', 'nick', 'live', 1, 0, 1600)`,
        [team.id],
      );
      // cy: asked nothing.
      const roster = await buildAppRoster(ctx, team, { id: 'b1' } as ChannelBinding, 3_000);
      const seat = (name: string) => roster.seats.find((s) => s.seat === name);
      expect(seat('ada')?.waiting).toEqual({ to: 'nick', since: 1_000 });
      expect(seat('bo')?.waiting).toBeUndefined();
      expect(seat('cy')?.waiting).toBeUndefined();
      void cy;
    });
  });

  describe('ADR 814: the roster carries the team as /live shows it, and what waits on you', () => {
    it('folds the injected roster into members and lists the binding person’s open asks', async () => {
      const ctx = operatorCtx({
        db: server.store,
        traceDb: server.traceStore,
        hub: new Hub(),
        config: server.config,
        rosterRoots: [],
      });
      const res = await fetch(`http://127.0.0.1:${port}/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dusk', creator: { name: 'nick', kind: 'human' } }),
      });
      expect(res.status).toBe(201);
      const team = (await getTeamBySlug(ctx.db, 'dusk'))!;
      const nick = (await ctx.db.get<{ id: string }>(
        `SELECT id FROM members WHERE team_id = ? AND name = 'nick'`,
        [team.id],
      ))!;
      const ada = (await addMember(ctx.db, team, { name: 'ada', kind: 'agent' })).row!;
      const send = (id: string, ts: number, meta: Record<string, unknown>) =>
        insertMessage(
          ctx.db,
          team.id,
          ada.id,
          nick.id,
          makeEnvelope({
            id,
            team: 'dusk',
            from: 'ada',
            to: { kind: 'member', name: 'nick' },
            act: 'ask',
            body: id === 'ask-1' ? 'Merge #3961?' : 'Which?',
            ts,
            meta,
          }),
        );
      await send('ask-1', 2_000, { species: 'approve', tier: 'standard' });
      await send('q-1', 2_500, {
        species: 'consult',
        question: { text: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
      });

      const people = [
        {
          name: 'nick',
          kind: 'human',
          presence: 'online',
          posture: 'active',
          presences: [],
          state: null,
        },
        {
          name: 'ada',
          kind: 'agent',
          presence: 'online',
          posture: 'working',
          presences: [{ status: 'online', model: 'claude-opus-5-5' }],
          state: null,
        },
      ] as unknown as MemberSummary[];
      ctx.memberSummaries = async () => people;
      const binding = { id: 'b1', member_id: nick.id } as ChannelBinding;
      const roster = await buildAppRoster(ctx, team, binding, 3_000);

      expect(roster.members?.map((m) => [m.name, m.state, m.label])).toEqual([
        ['ada', 'asking', 'asking nick'],
        ['nick', 'between', 'between tasks'],
      ]);
      expect(roster.members?.find((m) => m.name === 'ada')?.model).toBe('opus 5.5');
      // The ask and the question each once, oldest first.
      expect(roster.for_you?.map((f) => [f.id, f.kind, f.summary])).toEqual([
        ['ask-1', 'approve', 'Merge #3961?'],
        ['q-1', 'question', 'Which?'],
      ]);
    });

    it('carries no members without the hook, so the phone falls back to seats', async () => {
      const ctx = operatorCtx({
        db: server.store,
        traceDb: server.traceStore,
        hub: new Hub(),
        config: server.config,
        rosterRoots: [],
      });
      await fetch(`http://127.0.0.1:${port}/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'noon', creator: { name: 'nick', kind: 'human' } }),
      });
      const team = (await getTeamBySlug(ctx.db, 'noon'))!;
      const roster = await buildAppRoster(ctx, team, { id: 'b1' } as ChannelBinding, 3_000);
      expect(roster.members).toBeUndefined();
    });

    it('shows an ask only as the binding person’s /live would (ADR 407 read scope)', async () => {
      const ctx = operatorCtx({
        db: server.store,
        traceDb: server.traceStore,
        hub: new Hub(),
        config: server.config,
        rosterRoots: [],
      });
      await fetch(`http://127.0.0.1:${port}/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'eve-team', creator: { name: 'nick', kind: 'human' } }),
      });
      const team = (await getTeamBySlug(ctx.db, 'eve-team'))!;
      const nick = (await ctx.db.get<{ id: string }>(
        `SELECT id FROM members WHERE team_id = ? AND name = 'nick'`,
        [team.id],
      ))!;
      const ada = (await addMember(ctx.db, team, { name: 'ada', kind: 'agent' })).row!;
      const eve = (await addMember(ctx.db, team, { name: 'eve', kind: 'human' })).row!;
      // A confidential ask (ADR 407): ada asks nick about bo. Only ada, nick and admins see it.
      await insertMessage(
        ctx.db,
        team.id,
        ada.id,
        nick.id,
        makeEnvelope({
          id: 'conf-1',
          team: 'eve-team',
          from: 'ada',
          to: { kind: 'member', name: 'nick' },
          act: 'ask',
          body: 'Is bo ok?',
          ts: 2_000,
          meta: { species: 'consult', tier: 'standard', about: 'bo' },
        }),
      );
      ctx.memberSummaries = async () =>
        [
          {
            name: 'ada',
            kind: 'agent',
            presence: 'online',
            posture: 'working',
            presences: [],
            state: null,
          },
        ] as unknown as MemberSummary[];
      const asSeenBy = async (memberId: string) =>
        (await buildAppRoster(ctx, team, { id: 'b', member_id: memberId } as ChannelBinding, 3_000))
          .members?.[0]?.label;
      // eve is a team-grade member who is not party to it: ada reads as between tasks for her.
      expect(await asSeenBy(eve.id)).toBe('between tasks');
      // nick is its addressee (and an admin): ada is asking him.
      expect(await asSeenBy(nick.id)).toBe('asking nick');
    });

    it('carries the day’s moments as the binding person’s /live shows them (ADR 819, ADR 407)', async () => {
      const ctx = operatorCtx({
        db: server.store,
        traceDb: server.traceStore,
        hub: new Hub(),
        config: server.config,
        rosterRoots: [],
      });
      await fetch(`http://127.0.0.1:${port}/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'moment-team', creator: { name: 'nick', kind: 'human' } }),
      });
      const team = (await getTeamBySlug(ctx.db, 'moment-team'))!;
      const nick = (await ctx.db.get<{ id: string }>(
        `SELECT id FROM members WHERE team_id = ? AND name = 'nick'`,
        [team.id],
      ))!;
      const ada = (await addMember(ctx.db, team, { name: 'ada', kind: 'agent' })).row!;
      const eve = (await addMember(ctx.db, team, { name: 'eve', kind: 'human' })).row!;
      const now = Date.now();
      const post = (
        id: string,
        from: { id: string },
        fromName: string,
        meta?: Record<string, unknown>,
      ) =>
        insertMessage(
          ctx.db,
          team.id,
          from.id,
          null,
          makeEnvelope({
            id,
            team: 'moment-team',
            from: fromName,
            to: { kind: 'team' },
            act: 'message',
            body: id === 'said-1' ? 'lunch at 1' : 'done',
            ts: now - 60_000,
            ...(meta ? { meta } : {}),
          }),
        );
      await post('said-1', eve, 'eve');
      await post('goal-1', ada, 'ada', { goal_outcome: { goal_id: 'g-x', outcome: 'shipped' } });
      // A human-to-human DM is never a moment, and its pair is the only one who reads it anyway.
      await insertMessage(
        ctx.db,
        team.id,
        eve.id,
        nick.id,
        makeEnvelope({
          id: 'dm-1',
          team: 'moment-team',
          from: 'eve',
          to: { kind: 'member', name: 'nick' },
          act: 'message',
          body: 'psst',
          ts: now - 30_000,
        }),
      );
      ctx.memberSummaries = async () => [] as unknown as MemberSummary[];
      const kinds = async (memberId: string) =>
        (
          await buildAppRoster(ctx, team, { id: 'b', member_id: memberId } as ChannelBinding, now)
        ).moments?.map((m) => [m.id, m.kind]);
      // Team grade (ADR 407) hides only confidential asks, and an ask is never a moment, so both
      // people see what their /live shows: eve's line and ada's goal note, and no DM.
      for (const who of [eve.id, nick.id])
        expect((await kinds(who))?.sort()).toEqual([
          ['goal-1', 'goal'],
          ['said-1', 'said'],
        ]);
    });

    it('lists an ask in for_you only while /live shows it loud: lapsed and withdrawn asks leave', async () => {
      const ctx = operatorCtx({
        db: server.store,
        traceDb: server.traceStore,
        hub: new Hub(),
        config: server.config,
        rosterRoots: [],
      });
      await fetch(`http://127.0.0.1:${port}/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dead-asks', creator: { name: 'nick', kind: 'human' } }),
      });
      const team = (await getTeamBySlug(ctx.db, 'dead-asks'))!;
      const nick = (await ctx.db.get<{ id: string }>(
        `SELECT id FROM members WHERE team_id = ? AND name = 'nick'`,
        [team.id],
      ))!;
      const live = (await addMember(ctx.db, team, { name: 'live', kind: 'agent' })).row!;
      const NOW = 10 * 24 * 60 * 60_000;
      const DAY = 24 * 60 * 60_000;
      const ask = (id: string, ts: number, tier: string, thread?: string) =>
        insertMessage(
          ctx.db,
          team.id,
          live.id,
          nick.id,
          makeEnvelope({
            id,
            team: 'dead-asks',
            from: 'live',
            to: { kind: 'member', name: 'nick' },
            act: 'ask',
            body: `Deploy ${id}?`,
            ts,
            ...(thread ? { thread } : {}),
            meta: { species: 'approve', tier },
          }),
        );
      await ask('lapsed', NOW - 2 * DAY, 'standard');
      await ask('withdrawn', NOW - 3 * DAY, 'blocking');
      await ask('held', NOW - 4 * DAY, 'blocking');
      // The publisher withdraws a superseded deploy ask with a resolve on its thread (ADR 734).
      await insertMessage(
        ctx.db,
        team.id,
        live.id,
        nick.id,
        makeEnvelope({
          id: 'r-1',
          team: 'dead-asks',
          from: 'live',
          to: { kind: 'member', name: 'nick' },
          act: 'resolve',
          body: 'main moved — withdrawn',
          ts: NOW - 3 * DAY + 60_000,
          thread: 'withdrawn',
        }),
      );
      ctx.memberSummaries = async () => [];
      const roster = await buildAppRoster(
        ctx,
        team,
        { id: 'b', member_id: nick.id } as ChannelBinding,
        NOW,
      );
      expect(roster.for_you?.map((f) => f.id)).toEqual(['held']);
    });
  });
});
