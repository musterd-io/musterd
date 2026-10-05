import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('calendar-http', (_o, kind) => {
  /**
   * ADR 519 on one daemon: the Team's calendar is team data — a human and an agent both read and
   * write it, every change is one audit row, the import is idempotent on `source_ref`, and a
   * `?since` delta carries deletes as well as writes.
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
  const demo = {
    title: 'SF Tech Week demo',
    date: '2026-10-08',
    start: '14:00',
    end: '14:30',
    kind: 'demo',
    status: 'going',
    pick: true,
  };

  async function calendarAudit() {
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    return (await listAudit(server.store, team.id))
      .filter((r) => r.action.startsWith('calendar.'))
      .map((r) => [r.action, r.actor, r.target]);
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

  it('a human writes an entry and an agent reads it, defaults filled, in calendar order', async () => {
    const made = await call('POST', '/teams/dawn/calendar', nick, demo);
    expect(made.status).toBe(201);
    expect(made.json.outcome).toBe('created');
    expect(made.json.entry).toMatchObject({
      ...demo,
      tz: 'America/Los_Angeles',
      place: '',
      url: null,
      source_ref: null,
      created_by: 'nick',
    });
    const allDay = await call('POST', '/teams/dawn/calendar', ada, {
      title: 'Deck due',
      date: '2026-10-08',
      kind: 'deadline',
    });
    expect(allDay.status).toBe(201);
    expect(allDay.json.entry.created_by).toBe('ada');

    const read = await call('GET', '/teams/dawn/calendar', ada);
    expect(read.status).toBe(200);
    expect(read.json.entries.map((e: any) => e.title)).toEqual(['Deck due', 'SF Tech Week demo']);
    expect(read.json.deleted).toEqual([]);
    expect(typeof read.json.now).toBe('number');
  });

  it('refuses a malformed body at the boundary', async () => {
    const bad = [
      { ...demo, date: '2026-02-30' },
      { ...demo, kind: 'party' },
      { ...demo, url: 'http://example.com' },
      { ...demo, start: null },
      { date: '2026-10-08', kind: 'demo' },
    ];
    for (const b of bad)
      expect((await call('POST', '/teams/dawn/calendar', nick, b)).status).toBe(400);
    expect((await call('GET', '/teams/dawn/calendar', nick)).json.entries).toEqual([]);
  });

  it('the import is idempotent on source_ref: created, then unchanged, then updated', async () => {
    const imported = { ...demo, source_ref: 'artifact-doc-1' };
    const first = await call('POST', '/teams/dawn/calendar', nick, imported);
    expect([first.status, first.json.outcome]).toEqual([201, 'created']);
    const again = await call('POST', '/teams/dawn/calendar', nick, imported);
    expect([again.status, again.json.outcome]).toEqual([200, 'unchanged']);
    expect(again.json.entry.id).toBe(first.json.entry.id);
    const moved = await call('POST', '/teams/dawn/calendar', nick, {
      ...imported,
      start: '15:00',
      end: null,
    });
    expect([moved.status, moved.json.outcome]).toEqual([200, 'updated']);
    expect(moved.json.entry).toMatchObject({ id: first.json.entry.id, start: '15:00', end: null });

    expect((await call('GET', '/teams/dawn/calendar', nick)).json.entries).toHaveLength(1);
    // An unchanged write audits nothing: two rows, not three.
    expect(await calendarAudit()).toEqual([
      ['calendar.entry_written', 'nick', first.json.entry.id],
      ['calendar.entry_written', 'nick', first.json.entry.id],
    ]);
  });

  it('PUT replaces an entry; an unknown id is not_found; a stolen source_ref is a conflict', async () => {
    const a = (await call('POST', '/teams/dawn/calendar', nick, { ...demo, source_ref: 'r1' })).json
      .entry;
    const b = (await call('POST', '/teams/dawn/calendar', nick, { ...demo, title: 'Other' })).json
      .entry;

    const put = await call('PUT', `/teams/dawn/calendar/${b.id}`, ada, {
      title: 'Other, moved',
      date: '2026-10-09',
      kind: 'event',
    });
    expect(put.status).toBe(200);
    expect(put.json.outcome).toBe('updated');
    // A PUT is a whole replacement: what it omits reads as the default.
    expect(put.json.entry).toMatchObject({
      id: b.id,
      title: 'Other, moved',
      start: null,
      status: null,
      pick: false,
      created_by: 'nick',
    });
    expect(put.json.entry.updated_at).toBeGreaterThanOrEqual(b.updated_at);

    expect((await call('PUT', '/teams/dawn/calendar/nope', nick, demo)).status).toBe(404);
    const steal = await call('PUT', `/teams/dawn/calendar/${b.id}`, nick, {
      ...demo,
      source_ref: 'r1',
    });
    expect(steal.status).toBe(409);
    expect(steal.json.error.message).toContain(a.id);
  });

  it('a delete is real, audited, and a ?since delta carries it with the writes after it', async () => {
    const a = (await call('POST', '/teams/dawn/calendar', nick, demo)).json.entry;
    const mark = (await call('GET', '/teams/dawn/calendar', nick)).json.now;
    const b = (await call('POST', '/teams/dawn/calendar', ada, { ...demo, title: 'Later' })).json
      .entry;

    const del = await call('DELETE', `/teams/dawn/calendar/${a.id}`, ada);
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true });
    expect((await call('DELETE', `/teams/dawn/calendar/${a.id}`, ada)).status).toBe(404);

    const delta = await call('GET', `/teams/dawn/calendar?since=${mark}`, nick);
    expect(delta.status).toBe(200);
    expect(delta.json.entries.map((e: any) => e.id)).toEqual([b.id]);
    expect(delta.json.deleted).toEqual([a.id]);
    expect(delta.json.now).toBeGreaterThanOrEqual(mark);

    expect(
      (await call('GET', '/teams/dawn/calendar', nick)).json.entries.map((e: any) => e.id),
    ).toEqual([b.id]);
    expect(await calendarAudit()).toEqual(
      expect.arrayContaining([['calendar.entry_deleted', 'ada', a.id]]),
    );
    expect((await call('GET', '/teams/dawn/calendar?since=-1', nick)).status).toBe(422);
  });

  it('needs a member credential', async () => {
    expect((await call('GET', '/teams/dawn/calendar', 'mscr_nope')).status).toBe(401);
    expect((await call('POST', '/teams/dawn/calendar', 'mscr_nope', demo)).status).toBe(401);
  });
});
