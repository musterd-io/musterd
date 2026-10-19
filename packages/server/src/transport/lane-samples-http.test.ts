import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/** ADR 673 over HTTP: a metric rides lane_open, samples post and come back on the board. */
withDrivers('lane samples http (ADR 673)', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let nick: string;
  let ada: AgentHttpAuth;

  async function call(method: string, path: string, auth: string | AgentHttpAuth, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${typeof auth === 'string' ? auth : auth.key}`,
        ...(typeof auth === 'object'
          ? { 'x-musterd-session-lease': auth.sessionLease, 'x-musterd-seat': 'ada' }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
    const team = await call('POST', '/teams', '', {
      slug: 'dawn',
      creator: { name: 'nick', kind: 'human' },
    });
    nick = team.json.human_credential;
    await call('POST', '/teams/dawn/members', nick, { name: 'ada', kind: 'agent' });
    ada = await claimAgentHttp(base, 'dawn', team.json.agent_key, nick, 'ada');
  });

  afterEach(async () => {
    await server.close();
  });

  it('opens with a metric, takes samples from any member, and serves them on brief=1', async () => {
    const opened = await call('POST', '/teams/dawn/lanes', nick, {
      title: 'does ranking help',
      reads_on: '2026-10-21',
      metric: { name: 'hit rate', unit: '%', baseline: 40, target: 60, direction: 'up' },
    });
    expect(opened.status).toBe(201);
    expect(opened.json.lane.metric).toMatchObject({ source: 'manual', by: 'nick' });
    const id = opened.json.lane.id as string;
    const posted = await call('POST', `/teams/dawn/lanes/${id}/samples`, ada, {
      day: '2026-10-19',
      value: 61,
      n: 23,
    });
    expect(posted.status).toBe(201);
    expect(posted.json).toMatchObject({ sample: { value: 61, by: 'ada' }, replaced: null });
    const board = await call('GET', '/teams/dawn/lanes?brief=1', nick);
    const lane = board.json.lanes.find((l: { id: string }) => l.id === id);
    expect(lane.samples).toEqual([
      expect.objectContaining({ day: '2026-10-19', value: 61, n: 23 }),
    ]);
  });

  it('refuses a malformed sample and a lane with no metric', async () => {
    const plain = await call('POST', '/teams/dawn/lanes', nick, { title: 'plain' });
    const id = plain.json.lane.id as string;
    expect(
      (
        await call('POST', `/teams/dawn/lanes/${id}/samples`, nick, {
          day: 'yesterday',
          value: 1,
          n: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/teams/dawn/lanes/${id}/samples`, nick, {
          day: '2026-10-19',
          value: 1,
          n: 1,
        })
      ).status,
    ).toBe(400);
  });
});
