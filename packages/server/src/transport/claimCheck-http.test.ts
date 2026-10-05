import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('claimCheck-http', (_o, kind) => {
  /**
   * ADR 522 through the routes a seat actually reads: its memory and its brief. The demo-freeze
   * note is the case — saved by one seat, read back after the slot, with nothing set to back it.
   */
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

  it('memory read back: a freeze nobody set is unsourced; once a hold backs it, it is current', async () => {
    await call('PUT', '/teams/dawn/memory', ada, {
      headline: 'demo day',
      body: 'Demo at 2pm. No merges until after the demo.',
    });
    const before = await call('GET', '/teams/dawn/memory', ada);
    expect(before.json.checks).toEqual([
      expect.objectContaining({ kind: 'rule', verdict: 'unsourced' }),
    ]);
    await call('POST', '/teams/dawn/holds', nick, {
      effect: 'merges_paused',
      reason: 'demo 14:00',
      for_ms: 3600_000,
    });
    const after = await call('GET', '/teams/dawn/memory', ada);
    expect(after.json.checks[0]).toMatchObject({ kind: 'rule', verdict: 'current' });
    expect(after.json.checks[0].line).toContain('merges paused by nick');
  });

  it('a note with nothing to correct reads back with an empty margin', async () => {
    await call('PUT', '/teams/dawn/memory', ada, { headline: 'h', body: 'tests half written' });
    expect((await call('GET', '/teams/dawn/memory', ada)).json.checks).toEqual([]);
  });

  it("the brief's handoff carries its checks", async () => {
    const sent = await call('POST', '/teams/dawn/messages', nick, {
      envelope: makeEnvelope({
        id: ulid(),
        team: 'dawn',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'handoff',
        body: 'Over to you. Hold off on refreshing the daemon until the demo.',
        ts: Date.now(),
      }),
    });
    expect(sent.status).toBeLessThan(300);
    const brief = await call('GET', '/teams/dawn/next', ada);
    expect(brief.json.why.checks).toEqual([
      expect.objectContaining({ kind: 'rule', verdict: 'unsourced' }),
    ]);
  });
});
