import { ASK_WITHHOLD_MAX_MS, makeEnvelope } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { openWithholds } from './askWithhold.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;
const NOW = 1_800_000_000_000;

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
  return { db, team, nick, ada };
}

async function send(
  db: Driver,
  team: TeamRow,
  from: MemberRow,
  fields: { id: string; act: string; meta?: Record<string, unknown>; thread?: string; ts: number },
): Promise<void> {
  const env = makeEnvelope({
    id: fields.id,
    team: team.slug,
    from: from.name,
    to: { kind: 'team' },
    act: fields.act as never,
    body: 'x',
    ...(fields.meta ? { meta: fields.meta } : {}),
    ...(fields.thread ? { thread: fields.thread } : {}),
    ts: fields.ts,
  });
  await insertMessage(db, team.id, from.id, null, env);
}

const blocking = { species: 'approve', tier: 'blocking' };

withDrivers('askWithhold (ADR 801)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  it('a seat-raised blocking approve ask with no meta.withhold holds the seat seat-wide', async () => {
    const { db, team, ada } = await seed();
    await send(db, team, ada, { id: 'a1', act: 'ask', meta: blocking, ts: NOW - 1000 });
    const open = await openWithholds(db, team.id, ada.id, NOW);
    expect(open).toEqual([
      {
        ask_id: 'a1',
        commands: [],
        paths: [],
        seat_wide: true,
        declined: false,
        expires_at: NOW - 1000 + ASK_WITHHOLD_MAX_MS,
      },
    ]);
  });

  it('meta.withhold scopes it to the named globs', async () => {
    const { db, team, ada } = await seed();
    await send(db, team, ada, {
      id: 'a1',
      act: 'ask',
      meta: { ...blocking, withhold: { commands: ['gh release create *'] } },
      ts: NOW - 1000,
    });
    const [w] = await openWithholds(db, team.id, ada.id, NOW);
    expect(w).toMatchObject({ seat_wide: false, commands: ['gh release create *'], paths: [] });
  });

  it('a human accept releases it; a decline keeps it, marked declined', async () => {
    const { db, team, nick, ada } = await seed();
    await send(db, team, ada, { id: 'a1', act: 'ask', meta: blocking, ts: NOW - 3000 });
    await send(db, team, ada, { id: 'a2', act: 'ask', meta: blocking, ts: NOW - 2000 });
    await send(db, team, nick, {
      id: 'n1',
      act: 'accept',
      meta: { in_reply_to: 'a1', human_authority_checked: true },
      ts: NOW - 1000,
    });
    await send(db, team, nick, {
      id: 'n2',
      act: 'decline',
      meta: { in_reply_to: 'a2', human_authority_checked: true },
      ts: NOW - 900,
    });
    const open = await openWithholds(db, team.id, ada.id, NOW);
    expect(open.map((w) => [w.ask_id, w.declined])).toEqual([['a2', true]]);
  });

  it('the seat withdrawing its ask (resolve on the thread) lifts it', async () => {
    const { db, team, ada } = await seed();
    await send(db, team, ada, { id: 'a1', act: 'ask', meta: blocking, ts: NOW - 2000 });
    await send(db, team, ada, {
      id: 'r1',
      act: 'resolve',
      thread: 'a1',
      meta: { ask_outcome: 'held' },
      ts: NOW - 1000,
    });
    expect(await openWithholds(db, team.id, ada.id, NOW)).toEqual([]);
  });

  it('ends at 12h, and never comes from a lower tier, another seat, or a structured ask', async () => {
    const { db, team, nick, ada } = await seed();
    await send(db, team, ada, {
      id: 'old',
      act: 'ask',
      meta: blocking,
      ts: NOW - ASK_WITHHOLD_MAX_MS - 1,
    });
    await send(db, team, ada, {
      id: 'std',
      act: 'ask',
      meta: { species: 'approve', tier: 'standard' },
      ts: NOW - 1000,
    });
    await send(db, team, ada, {
      id: 'review',
      act: 'ask',
      meta: { ...blocking, lane_review: { lane: 'L1', title: 't' } },
      ts: NOW - 1000,
    });
    await send(db, team, ada, {
      id: 'gate',
      act: 'ask',
      meta: { ...blocking, gate: { class: 'c', fingerprint: 'f' } },
      ts: NOW - 1000,
    });
    await send(db, team, nick, { id: 'nicks', act: 'ask', meta: blocking, ts: NOW - 1000 });
    expect(await openWithholds(db, team.id, ada.id, NOW)).toEqual([]);
  });

  it('a team with no human member withholds nothing — nobody there could release it', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'pair' });
    const a = (await addMember(db, team, { name: 'a', kind: 'agent' })).row;
    await send(db, team, a, { id: 'a1', act: 'ask', meta: blocking, ts: NOW - 1000 });
    expect(await openWithholds(db, team.id, a.id, NOW)).toEqual([]);
  });

  it('after a human decline, the seat withdrawing its own ask does not lift it', async () => {
    const { db, team, nick, ada } = await seed();
    await send(db, team, ada, { id: 'a1', act: 'ask', meta: blocking, ts: NOW - 3000 });
    await send(db, team, nick, {
      id: 'n1',
      act: 'decline',
      meta: { in_reply_to: 'a1', human_authority_checked: true },
      ts: NOW - 2000,
    });
    await send(db, team, ada, {
      id: 'r1',
      act: 'resolve',
      thread: 'a1',
      meta: { ask_outcome: 'held' },
      ts: NOW - 1000,
    });
    const open = await openWithholds(db, team.id, ada.id, NOW);
    expect(open.map((w) => [w.ask_id, w.declined])).toEqual([['a1', true]]);
  });
});
