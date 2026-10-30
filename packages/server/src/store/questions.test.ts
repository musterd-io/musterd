import { makeEnvelope, type Act } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAudit } from './audit.js';
import { openLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import {
  ANSWER_UNDELIVERED_MS,
  answerLineFor,
  claimAnswer,
  markAnswerDelivered,
  questionMeasures,
  sweepUndeliveredAnswers,
  openQuestions,
  questionView,
  waitingSeats,
} from './questions.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

const flake = {
  text: 'Re-run the red shard, or fix the flake first?',
  options: [{ label: 'Re-run the shard' }, { label: 'Fix the flake first' }],
};

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const swetha = (await addMember(db, team, { name: 'swetha', kind: 'human' })).row;
  const ryder = (await addMember(db, team, { name: 'ryder', kind: 'agent' })).row;
  return { db, team, nick, swetha, ryder };
}

async function send(
  db: Driver,
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
      body: '',
      thread: opts.thread ?? null,
      meta: opts.meta ?? null,
      ts,
    }),
  );
}

function ask(audience?: 'team') {
  return { species: 'consult', question: { ...flake, ...(audience ? { audience } : {}) } };
}

withDrivers('questions', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  it('a question with no reply is open, and its asker is waiting', async () => {
    const { db, team, nick, ryder } = await seed();
    await send(db, team, ryder, nick, 'ask', 'q1', 1, { meta: ask() });
    expect((await questionView(db, team.id, 'q1'))?.state).toBe('open');
    expect([...(await waitingSeats(db, team.id))]).toEqual(['ryder']);
  });

  it("the asker's resolve withdraws it; a lane-close resolve says so", async () => {
    const { db, team, nick, ryder } = await seed();
    await send(db, team, ryder, nick, 'ask', 'q1', 1, { meta: ask() });
    await send(db, team, ryder, nick, 'ask', 'q2', 2, { meta: ask() });
    await send(db, team, ryder, null, 'resolve', 'r1', 3, { thread: 'q1' });
    await send(db, team, ryder, null, 'resolve', 'r2', 4, {
      thread: 'q2',
      meta: { withdrawn: 'lane_closed' },
    });
    expect((await questionView(db, team.id, 'q1'))?.state).toBe('withdrawn');
    expect((await questionView(db, team.id, 'q2'))?.state).toBe('lane_closed');
    expect(await waitingSeats(db, team.id)).toEqual(new Set());
  });

  it('an answer closes it, the first answer wins, and a late one leaves the close standing', async () => {
    const { db, team, nick, ryder } = await seed();
    await send(db, team, ryder, nick, 'ask', 'q1', 1, { meta: ask('team') });
    const base = { questionId: 'q1', asker: 'ryder', verified: true, late: false, at: 5 };
    expect(
      await claimAnswer(db, team.id, { ...base, answerId: 'a1', by: 'nick', channel: 'live' }),
    ).toEqual({
      ok: true,
    });
    expect(
      await claimAnswer(db, team.id, { ...base, answerId: 'a2', by: 'swetha', channel: 'app' }),
    ).toEqual({ ok: false, by: 'nick', channel: 'live' });
    const v = await questionView(db, team.id, 'q1');
    expect(v?.state).toBe('answered');
    expect(v?.answer).toMatchObject({ id: 'a1', by: 'nick', channel: 'live', verified: true });
    expect(await openQuestions(db, team.id, { forPerson: 'swetha' })).toEqual([]);

    await send(db, team, ryder, nick, 'ask', 'q2', 6, { meta: ask() });
    await send(db, team, ryder, null, 'resolve', 'r2', 7, { thread: 'q2' });
    await claimAnswer(db, team.id, {
      ...base,
      questionId: 'q2',
      answerId: 'a3',
      by: 'nick',
      channel: 'live',
      late: true,
    });
    const late = await questionView(db, team.id, 'q2');
    expect(late?.state).toBe('withdrawn');
    expect(late?.answer?.late).toBe(true);
  });

  it('forPerson follows the audience: the addressee only, or anyone for a team question', async () => {
    const { db, team, nick, swetha, ryder } = await seed();
    await send(db, team, ryder, swetha, 'ask', 'q1', 1, { meta: ask() });
    await send(db, team, ryder, swetha, 'ask', 'q2', 2, { meta: ask('team') });
    await send(db, team, ryder, nick, 'ask', 'plain', 3, {
      meta: { species: 'consult', tier: 'advisory' },
    });
    expect((await openQuestions(db, team.id, { forPerson: 'nick' })).map((q) => q.id)).toEqual([
      'q2',
    ]);
    expect((await openQuestions(db, team.id, { forPerson: 'swetha' })).map((q) => q.id)).toEqual([
      'q1',
      'q2',
    ]);
    expect(await openQuestions(db, team.id, { forPerson: 'ryder' })).toEqual([]);
  });

  it('a closed lane closes its questions, on read', async () => {
    const { db, team, nick, ryder } = await seed();
    const lane = await openLane(db, team.id, 'revive', 'ryder', { title: 't', claim: true });
    await send(db, team, ryder, nick, 'ask', 'q1', 1, {
      meta: { species: 'consult', question: { ...flake, context: { lane: lane.id } } },
    });
    expect((await questionView(db, team.id, 'q1'))?.state).toBe('open');
    await db.run("UPDATE lanes SET state = 'done' WHERE id = ?", [lane.id]);
    expect((await questionView(db, team.id, 'q1'))?.state).toBe('lane_closed');
    expect(await waitingSeats(db, team.id)).toEqual(new Set());
  });

  it('a claim whose answer never persisted is taken over after the grace window', async () => {
    const { db, team, nick, ryder } = await seed();
    await send(db, team, ryder, nick, 'ask', 'q1', 1, { meta: ask() });
    const base = {
      questionId: 'q1',
      asker: 'ryder',
      by: 'nick',
      channel: 'live' as const,
      verified: true,
      late: false,
    };
    expect(await claimAnswer(db, team.id, { ...base, answerId: 'ghost', at: 1_000 })).toEqual({
      ok: true,
    });
    expect(
      (await claimAnswer(db, team.id, { ...base, answerId: 'a2', at: 1_000 + 5_000 })).ok,
    ).toBe(false);
    expect(await claimAnswer(db, team.id, { ...base, answerId: 'a3', at: 1_000 + 61_000 })).toEqual(
      { ok: true },
    );
  });

  it('answerLineFor gives the asker the fenced answer, and nobody else anything', async () => {
    const { db, team, nick, ryder } = await seed();
    await send(db, team, ryder, nick, 'ask', 'q1', 1, { meta: ask() });
    const proof = { channel: 'live', verified: true, by: 'nick' };
    await send(db, team, nick, ryder, 'accept', 'a1', 2, {
      meta: {
        in_reply_to: 'q1',
        answer: { choice: 1, text: 'then ping big-body' },
        answer_proof: proof,
      },
    });
    expect(await answerLineFor(db, team.id, 'revive', 'ryder', 'a1')).toBe(
      '⚡ musterd [revive]: nick answered your question q1 (via live) — «"Fix the flake first" — then ping big-body» — act on it; ack with team_wake_context {act_id: "a1"}',
    );
    expect(await answerLineFor(db, team.id, 'revive', 'ryder', 'a1', { recap: true })).toContain(
      `you asked: «${flake.text}» —`,
    );
    expect(await answerLineFor(db, team.id, 'revive', 'swetha', 'a1')).toBeNull();
    await send(db, team, nick, ryder, 'accept', 'a2', 3, {
      meta: {
        in_reply_to: 'q1',
        answer: { choice: 0 },
        answer_proof: { ...proof, verified: false },
      },
    });
    expect(await answerLineFor(db, team.id, 'revive', 'ryder', 'a2')).toBeNull();
  });

  it('delivery is marked once, by the asker only; the sweep flags a miss; the measures add up', async () => {
    const { db, team, nick, ryder } = await seed();
    await send(db, team, ryder, nick, 'ask', 'q1', 1, { meta: ask() });
    await send(db, team, ryder, nick, 'ask', 'q2', 2, { meta: ask() });
    const base = { asker: 'ryder', by: 'nick', verified: true, late: false };
    await claimAnswer(db, team.id, {
      ...base,
      questionId: 'q1',
      answerId: 'a1',
      channel: 'live',
      at: 10_000,
    });
    await claimAnswer(db, team.id, {
      ...base,
      questionId: 'q2',
      answerId: 'a2',
      channel: 'cli',
      at: 10_000,
    });

    expect(await markAnswerDelivered(db, team.id, 'a1', 'swetha', 'inject', 14_000)).toBe(false);
    expect(await markAnswerDelivered(db, team.id, 'a1', 'ryder', 'inject', 14_000)).toBe(true);
    expect(await markAnswerDelivered(db, team.id, 'a1', 'ryder', 'wake', 15_000)).toBe(false);
    expect((await questionView(db, team.id, 'q1'))?.answer?.delivered_at).toBe(14_000);

    expect(await sweepUndeliveredAnswers(db, team.id, 10_000 + ANSWER_UNDELIVERED_MS - 1)).toEqual(
      [],
    );
    const late = 10_000 + ANSWER_UNDELIVERED_MS + 1;
    expect(await sweepUndeliveredAnswers(db, team.id, late)).toEqual(['a2']);
    expect(await sweepUndeliveredAnswers(db, team.id, late + 1)).toEqual([]);
    expect((await questionView(db, team.id, 'q2'))?.answer?.undelivered).toBe(true);

    expect(await questionMeasures(db, team.id, 0, late)).toEqual({
      asked: 2,
      answered: 2,
      answered_off_terminal: 1,
      inferred: 0,
      delivered: 1,
      undelivered: 1,
      unflagged_undelivered: 0,
      resume_p50_ms: 4_000,
    });
    const audit = await listAudit(db, team.id);
    expect(
      JSON.parse(String(audit.find((r) => r.action === 'question.answer_delivered')?.detail)),
    ).toMatchObject({
      latency_ms: 4_000,
      via: 'inject',
    });
  });
});
