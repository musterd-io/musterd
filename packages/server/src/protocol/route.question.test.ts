import { makeEnvelope, type Envelope } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { listAudit } from '../store/audit.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { questionView } from '../store/questions.js';
import { createTeam } from '../store/teams.js';
import { routeEnvelope } from './route.js';

let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: { presenceTimeoutMs: 60_000 } as Ctx['config'],
    hub: {
      deliver: () => false,
      deliverToAdmins: () => 0,
      broadcastFirehose: () => 0,
    } as unknown as Ctx['hub'],
  };
}

const flake = {
  text: 'Re-run the red shard, or fix the flake first?',
  options: [{ label: 'Re-run the shard' }, { label: 'Fix the flake first' }],
};

/**
 * ADR 773 §3–§5: the answer to a question rides `accept` + `meta.answer`. The route checks the
 * target and the answerer, claims the question (the first answer wins), and stamps its own proof.
 */
withDrivers('route.question', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed(audience?: 'team') {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const swetha = (await addMember(db, team, { name: 'swetha', kind: 'human' })).row;
    const ryder = (await addMember(db, team, { name: 'ryder', kind: 'agent', role: '' })).row;
    const ctx = stubCtx(db);
    await routeEnvelope(
      ctx,
      team,
      ryder,
      makeEnvelope({
        id: 'q1',
        team: 'revive',
        from: 'ryder',
        to: { kind: 'member', name: 'nick' },
        act: 'ask',
        meta: { species: 'consult', question: { ...flake, ...(audience ? { audience } : {}) } },
      }),
    );
    return { db, team, nick, swetha, ryder, ctx };
  }

  function answer(id: string, from: string, meta: Record<string, unknown> = {}): Envelope {
    return makeEnvelope({
      id,
      team: 'revive',
      from,
      to: { kind: 'member', name: 'ryder' },
      act: 'accept',
      meta: { in_reply_to: 'q1', answer: { choice: 0 }, ...meta },
    });
  }

  async function proofOf(db: Driver, id: string): Promise<unknown> {
    const row = await db.get<{ meta: string }>('SELECT meta FROM messages WHERE id = ?', [id]);
    return row ? (JSON.parse(row.meta) as Record<string, unknown>)['answer_proof'] : undefined;
  }

  it("stamps the server's proof over a client's, and audits question.answered", async () => {
    const { db, team, nick, ctx } = await seed();
    await routeEnvelope(
      ctx,
      team,
      nick,
      answer('a1', 'nick', { answer_proof: { channel: 'app', verified: true, by: 'mallory' } }),
      undefined,
      false,
      undefined,
      undefined,
      'web',
    );
    expect(await proofOf(db, 'a1')).toEqual({ channel: 'live', verified: true, by: 'nick' });
    expect((await questionView(db, team.id, 'q1'))?.state).toBe('answered');
    const audit = await listAudit(db, team.id);
    expect(audit.some((r) => r.action === 'question.answered' && r.target === 'q1')).toBe(true);
  });

  it('a team question takes any human, and a CLI answer is labelled cli', async () => {
    const { db, team, swetha, ctx } = await seed('team');
    await routeEnvelope(ctx, team, swetha, answer('a1', 'swetha'));
    expect(await proofOf(db, 'a1')).toEqual({ channel: 'cli', verified: true, by: 'swetha' });
  });

  it('the first answer wins; the second is a 409 naming who answered, and writes nothing', async () => {
    const { db, team, nick, ctx } = await seed();
    await routeEnvelope(
      ctx,
      team,
      nick,
      answer('a1', 'nick'),
      undefined,
      false,
      undefined,
      undefined,
      'web',
    );
    const second = routeEnvelope(ctx, team, nick, answer('a2', 'nick'));
    await expect(second).rejects.toBeInstanceOf(MusterdError);
    await expect(second).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('question_already_answered: answered by nick on live'),
    });
    expect(await db.get('SELECT id FROM messages WHERE id = ?', ['a2'])).toBeUndefined();
  });

  it('only the addressee may answer an addressee question', async () => {
    const { team, swetha, ctx } = await seed();
    await expect(routeEnvelope(ctx, team, swetha, answer('a1', 'swetha'))).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('not_the_addressee'),
    });
  });

  it('an answer must be addressed to the asker, and meta.answer only answers a question', async () => {
    const { team, nick, ctx } = await seed();
    const toTeam = { ...answer('a1', 'nick'), to: { kind: 'team' as const } };
    await expect(routeEnvelope(ctx, team, nick, toTeam)).rejects.toMatchObject({
      code: 'bad_request',
    });
    const notAQuestion = answer('a2', 'nick', { in_reply_to: 'nope' });
    await expect(routeEnvelope(ctx, team, nick, notAQuestion)).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  // ADR 787 (superseding ADR 773 §3's late answer): a withdrawn question refuses an answer.
  it.each([
    ['withdrawn', {}],
    ['lane_closed', { withdrawn: 'lane_closed' }],
  ] as const)(
    'an answer after the question is %s is refused, audited, and writes nothing',
    async (state, meta) => {
      const { db, team, nick, ryder, ctx } = await seed();
      await routeEnvelope(
        ctx,
        team,
        ryder,
        makeEnvelope({
          id: 'r1',
          team: 'revive',
          from: 'ryder',
          to: { kind: 'team' },
          act: 'resolve',
          thread: 'q1',
          meta,
        }),
      );
      await expect(routeEnvelope(ctx, team, nick, answer('a1', 'nick'))).rejects.toMatchObject({
        code: 'conflict',
        message: expect.stringContaining('question_withdrawn'),
      });
      expect(await proofOf(db, 'a1')).toBeUndefined();
      const v = await questionView(db, team.id, 'q1');
      expect(v?.state).toBe(state);
      expect(v?.answer).toBeUndefined();
      const refused = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'question.answered' && r.result === 'deny',
      );
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ actor: 'nick', target: 'q1' });
      expect(JSON.parse(String(refused[0]?.detail))).toMatchObject({
        reason: state,
        channel: 'cli',
      });
    },
  );

  it('a seat cannot answer a question, even a team one', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ryder = (await addMember(db, team, { name: 'ryder', kind: 'agent', role: '' })).row;
    const gptbot = (await addMember(db, team, { name: 'gptbot', kind: 'agent', role: '' })).row;
    const ctx = stubCtx(db);
    await routeEnvelope(
      ctx,
      team,
      ryder,
      makeEnvelope({
        id: 'q1',
        team: 'revive',
        from: 'ryder',
        to: { kind: 'member', name: 'nick' },
        act: 'ask',
        meta: { species: 'consult', question: { ...flake, audience: 'team' } },
      }),
    );
    await expect(routeEnvelope(ctx, team, gptbot, answer('a1', 'gptbot'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await questionView(db, team.id, 'q1'))?.state).toBe('open');
    void nick;
  });

  it('an answer cannot act on a question that is also a gate (advice, never authority)', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ryder = (await addMember(db, team, { name: 'ryder', kind: 'agent', role: '' })).row;
    await insertMessage(
      db,
      team.id,
      ryder.id,
      nick.id,
      makeEnvelope({
        id: 'q1',
        team: 'revive',
        from: 'ryder',
        to: { kind: 'member', name: 'nick' },
        act: 'ask',
        meta: { species: 'consult', question: flake, gate: { tool: 'Bash' } },
      }),
    );
    await expect(
      routeEnvelope(stubCtx(db), team, nick, answer('a1', 'nick')),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await questionView(db, team.id, 'q1'))?.state).toBe('open');
  });

  function inferred(id: string, from: string): Envelope {
    return makeEnvelope({
      id,
      team: 'revive',
      from,
      to: { kind: 'team' },
      act: 'ask',
      body: 'Want me to start on 3a?',
      meta: {
        species: 'consult',
        question: { text: 'Want me to start on 3a?', audience: 'team', inferred: true },
      },
    });
  }

  it('ADR 781: an inferred question waits while the seat has any open question', async () => {
    const { db, team, ryder, ctx } = await seed();
    // ryder's explicit q1 is still open, so the catcher's card is refused.
    await expect(routeEnvelope(ctx, team, ryder, inferred('i1', 'ryder'))).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('question_already_open'),
    });
    await routeEnvelope(
      ctx,
      team,
      ryder,
      makeEnvelope({
        id: 'w1',
        team: 'revive',
        from: 'ryder',
        to: { kind: 'team' },
        act: 'resolve',
        thread: 'q1',
        meta: { withdrawn: 'answered_in_session' },
      }),
    );
    await routeEnvelope(ctx, team, ryder, inferred('i2', 'ryder'));
    expect((await questionView(db, team.id, 'i2'))?.question.inferred).toBe(true);
    // A second turn ending on a question while i2 is open adds no second card.
    await expect(routeEnvelope(ctx, team, ryder, inferred('i3', 'ryder'))).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it("ADR 781: a person's own session never raises an inferred question", async () => {
    const { team, swetha, ctx } = await seed();
    await expect(routeEnvelope(ctx, team, swetha, inferred('i1', 'swetha'))).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
