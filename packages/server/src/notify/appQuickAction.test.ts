import { makeEnvelope } from '@musterd/protocol';
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
});
