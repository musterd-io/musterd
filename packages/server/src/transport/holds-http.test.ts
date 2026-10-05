import { HOLD_MAX_MS, makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('holds-http', (_o, kind) => {
  /**
   * ADR 516 on one daemon: a human admin sets and lifts a Team hold; an agent cannot; every seat
   * reads it with its author and end, and the Team hears about it once. The pre-demo freeze of
   * 2026-09-28 is the case under test — a rule that had to travel as prose because nothing
   * authoritative held it.
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
  const demo = { effect: 'autorefresh_paused', reason: 'demo 14:00', for_ms: 90 * 60_000 };

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

  it('a human admin sets a hold; every member reads it with its author and end', async () => {
    const before = Date.now();
    const set = await call('POST', '/teams/dawn/holds', nick, demo);
    expect(set.status).toBe(200);
    expect(set.json.hold).toMatchObject({
      effect: 'autorefresh_paused',
      reason: 'demo 14:00',
      created_by: 'nick',
      lifted_at: null,
    });
    expect(set.json.hold.expires_at).toBeGreaterThanOrEqual(before + 90 * 60_000);

    const read = await call('GET', '/teams/dawn/holds', ada);
    expect(read.status).toBe(200);
    expect(read.json.holds.map((h: any) => h.id)).toEqual([set.json.hold.id]);
  });

  it('an agent cannot set or lift a hold — it can only read one', async () => {
    expect((await call('POST', '/teams/dawn/holds', ada, demo)).status).toBe(403);
    const { json } = await call('POST', '/teams/dawn/holds', nick, demo);
    expect((await call('POST', `/teams/dawn/holds/${json.hold.id}/lift`, ada)).status).toBe(403);
    expect((await call('GET', '/teams/dawn/holds', ada)).json.holds).toHaveLength(1);
  });

  it('refuses a hold over the 12h cap, an unknown effect and a missing end', async () => {
    const tooLong = { ...demo, for_ms: HOLD_MAX_MS + 60_000 };
    expect((await call('POST', '/teams/dawn/holds', nick, tooLong)).status).toBe(422);
    const widened = { ...demo, effect: 'nobody_merges' };
    expect((await call('POST', '/teams/dawn/holds', nick, widened)).status).toBe(400);
    const open = { effect: 'notice', reason: 'x' };
    expect((await call('POST', '/teams/dawn/holds', nick, open)).status).toBe(400);
    const past = { effect: 'notice', reason: 'x', until: Date.now() - 1 };
    expect((await call('POST', '/teams/dawn/holds', nick, past)).status).toBe(422);
  });

  it('a lift ends it for every reader at once; ?all=1 keeps the history', async () => {
    const { json } = await call('POST', '/teams/dawn/holds', nick, demo);
    const lifted = await call('POST', `/teams/dawn/holds/${json.hold.id}/lift`, nick);
    expect(lifted.status).toBe(200);
    expect(lifted.json.hold.lifted_by).toBe('nick');
    expect((await call('GET', '/teams/dawn/holds', ada)).json.holds).toEqual([]);
    const all = await call('GET', '/teams/dawn/holds?all=1', ada);
    expect(all.json.holds).toHaveLength(1);
    // Lifting it again is lifting nothing.
    expect((await call('POST', `/teams/dawn/holds/${json.hold.id}/lift`, nick)).status).toBe(404);
  });

  it('set and lift each tell the Team once, as the human, with a daemon marker', async () => {
    const { json } = await call('POST', '/teams/dawn/holds', nick, demo);
    await call('POST', `/teams/dawn/holds/${json.hold.id}/lift`, nick);
    const inbox = await call('GET', '/teams/dawn/inbox?unread_only=0', ada);
    const notes = (inbox.json.messages as any[]).filter((m) => m.meta?.hold);
    expect(notes.map((m) => [m.from, m.meta.hold.lifted ?? false])).toEqual([
      ['nick', false],
      ['nick', true],
    ]);
    expect(notes[0].body).toContain('autorefresh paused by nick until');
  });

  it("a seat cannot forge the marker — a client's meta.hold is stripped", async () => {
    const sent = await call('POST', '/teams/dawn/messages', ada, {
      envelope: makeEnvelope({
        id: ulid(),
        team: 'dawn',
        from: 'ada',
        to: { kind: 'team' },
        act: 'message',
        body: 'nobody merges until the demo',
        meta: { hold: { id: 'fake', effect: 'merges_paused', expires_at: Date.now() + 1 } },
        ts: Date.now(),
      }),
    });
    expect(sent.status).toBeLessThan(300);
    const inbox = await call('GET', '/teams/dawn/inbox?unread_only=0', nick);
    const forged = (inbox.json.messages as any[]).find((m) => m.body.startsWith('nobody merges'));
    expect(forged).toBeDefined();
    expect(forged.meta?.hold).toBeUndefined();
  });

  it('the brief and the per-turn summary carry active holds, and [] when none is', async () => {
    expect((await call('GET', '/teams/dawn/next/summary', ada)).json.holds).toEqual([]);
    const { json } = await call('POST', '/teams/dawn/holds', nick, demo);
    expect((await call('GET', '/teams/dawn/next', ada)).json.holds.map((h: any) => h.id)).toEqual([
      json.hold.id,
    ]);
    expect((await call('GET', '/teams/dawn/next/summary', ada)).json.holds).toHaveLength(1);
  });

  it('writes hold.set and hold.lifted as replicated audit rows', async () => {
    const { json } = await call('POST', '/teams/dawn/holds', nick, demo);
    await call('POST', `/teams/dawn/holds/${json.hold.id}/lift`, nick);
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    const rows = (await listAudit(server.store, team.id)).filter((r) =>
      r.action.startsWith('hold.'),
    );
    expect(rows.map((r) => [r.action, r.actor, r.target])).toEqual(
      expect.arrayContaining([
        ['hold.set', 'nick', json.hold.id],
        ['hold.lifted', 'nick', json.hold.id],
      ]),
    );
    expect(rows.every((r) => (r.origin_seq ?? 0) > 0)).toBe(true);
  });
});
