import { makeEnvelope, type Act } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { openLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { claimAnswer, openQuestions, questionView, waitingSeats } from './questions.js';
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
    const { db, team, nick, swetha, ryder } = await seed();
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
});
