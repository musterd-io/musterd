import type { WSServerFrame } from '@musterd/protocol';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { deliverFoldedLive } from '../protocol/route.js';
import { getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub, type Connection } from '../transport/hub.js';

withDrivers('folded live delivery (latency step 2b)', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let hub: Hub;
  let ctx: Ctx;

  const conn = (
    memberId: string,
    name: string,
    teamId: string,
    frames: WSServerFrame[],
    visibility?: Connection['visibility'],
  ): Connection => ({
    connId: `c-${name}`,
    memberId,
    memberName: name,
    teamId,
    presenceId: `p-${name}`,
    ...(visibility ? { visibility } : {}),
    send: (f) => void frames.push(f),
  });

  async function post(path: string, body: unknown, auth?: string) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return (await r.json()) as any;
  }

  /** Insert the way the fold does: a row from a seat on this team, nothing routed. */
  async function folded(id: string, from: string, to: string | null) {
    const team = (await getTeamBySlug(server.store, 'bravo'))!;
    const sender = (await getMemberByName(server.store, team.id, from))!;
    const target = to ? (await getMemberByName(server.store, team.id, to))! : null;
    await insertMessage(
      server.store,
      team.id,
      sender.id,
      target?.id ?? null,
      makeEnvelope({
        id,
        team: 'bravo',
        from,
        to: target ? { kind: 'member' as const, name: to! } : { kind: 'team' as const },
        act: 'message',
        body: `body ${id}`,
        ts: 1000,
      }),
    );
    return { team, sender, target };
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
    const created = await post('/teams', {
      slug: 'bravo',
      creator: { name: 'nick', kind: 'human' },
    });
    await post('/teams/bravo/members', { name: 'ada', kind: 'agent' }, created.human_credential);
    await post('/teams/bravo/members', { name: 'bea', kind: 'agent' }, created.human_credential);
    hub = new Hub();
    ctx = { db: server.store, hub, config: resolveConfig(), rosterRoots: [] };
  });

  afterEach(async () => {
    await server.close();
  });

  it('pushes a folded team act to every connected recipient but the sender, once', async () => {
    const { team, sender } = await folded('f-1', 'nick', null);
    const ada = (await getMemberByName(server.store, team.id, 'ada'))!;
    const bea = (await getMemberByName(server.store, team.id, 'bea'))!;
    const adaFrames: WSServerFrame[] = [];
    const beaFrames: WSServerFrame[] = [];
    const nickFrames: WSServerFrame[] = [];
    hub.add(conn(ada.id, 'ada', team.id, adaFrames));
    hub.add(conn(bea.id, 'bea', team.id, beaFrames));
    hub.add(conn(sender.id, 'nick', team.id, nickFrames));

    await deliverFoldedLive(ctx, 'bravo', ['f-1']);

    expect(adaFrames).toHaveLength(1);
    expect(beaFrames).toHaveLength(1);
    expect(nickFrames).toHaveLength(0);
    const frame = adaFrames[0] as { type: string; envelope: { id: string; from: string } };
    expect(frame.type).toBe('deliver');
    expect(frame.envelope.id).toBe('f-1');
    expect(frame.envelope.from).toBe('nick');
  });

  it('a directed act reaches its target only; firehose follows its grade', async () => {
    const { team } = await folded('f-2', 'nick', 'ada');
    const ada = (await getMemberByName(server.store, team.id, 'ada'))!;
    const bea = (await getMemberByName(server.store, team.id, 'bea'))!;
    const adaFrames: WSServerFrame[] = [];
    const beaFrames: WSServerFrame[] = [];
    const teamWatch: WSServerFrame[] = [];
    const publicWatch: WSServerFrame[] = [];
    hub.add(conn(ada.id, 'ada', team.id, adaFrames));
    hub.add(conn(bea.id, 'bea', team.id, beaFrames));
    const grade = (id: string, frames: WSServerFrame[], v: Connection['visibility']) => {
      const c = conn(`watcher-${id}`, id, team.id, frames, v);
      hub.add(c);
      hub.subscribeFirehose(c.connId);
    };
    grade('team', teamWatch, 'team');
    grade('public', publicWatch, 'public');

    await deliverFoldedLive(ctx, 'bravo', ['f-2']);

    expect(adaFrames).toHaveLength(1);
    expect(beaFrames).toHaveLength(0); // not addressed, not watching
    expect(teamWatch).toHaveLength(1); // ADR 407: a directed act reaches team-grade watchers
    expect(publicWatch).toHaveLength(0); // ...and never a public watch-link
  });

  it('a seat that is not connected is a no-op, never an error', async () => {
    await folded('f-3', 'nick', null);
    await expect(deliverFoldedLive(ctx, 'bravo', ['f-3', 'does-not-exist'])).resolves.toBe(0);
  });
});
