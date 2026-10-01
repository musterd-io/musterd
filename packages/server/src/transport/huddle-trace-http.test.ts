import { HuddleTraceSchema, PROTOCOL_VERSION } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getTeamBySlug } from '../store/teams.js';
import { ingestTraceEvents } from '../store/trace.js';

withDrivers('huddle-trace-http', (_o, kind) => {
  /**
   * `GET /teams/:slug/huddles/:id/trace` (ADR 493). Asserted here: a seat in the room reads the
   * joined timeline; a Member outside the room gets the same 404 as a missing huddle (ADR 128 — the
   * route is not an oracle for which huddles exist); tool rows arrive structural-only.
   */
  let server: RunningServer;
  let base: string;
  let nickTok: string;
  let bobTok: string;
  let cyTok: string;

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  const T0 = Date.now() - 60_000;

  beforeEach(async () => {
    server = createServer({
      db: await openTestDriver(kind),
      traceDb: await openTestDriver(kind, { store: 'trace' }),
      port: 0,
    });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const team = await fetch(`${base}/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
    }).then((r) => r.json() as Promise<any>);
    nickTok = team.human_credential;
    bobTok = (await call('POST', '/teams/dawn/members', nickTok, { name: 'Bob', kind: 'human' }))
      .json.human_credential;
    await call('POST', '/teams/dawn/members', nickTok, { name: 'Ada', kind: 'human' });
    cyTok = (await call('POST', '/teams/dawn/members', nickTok, { name: 'Cy', kind: 'human' })).json
      .human_credential;

    const root = {
      id: 'h-root',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from: 'nick',
      to: { kind: 'team' },
      act: 'message',
      body: 'why we are huddling',
      meta: {
        eligible: ['Bob', 'Ada'],
        huddle: {
          topic: { kind: 'goal', id: 'demo' },
          room: 'http://127.0.0.1:4851/b/huddle-h-root',
          anchor: 'docs/demo/options.md',
        },
      },
      ts: T0,
    };
    await call('POST', '/teams/dawn/messages', nickTok, { envelope: root });
    await call('POST', '/teams/dawn/messages', bobTok, {
      envelope: {
        ...root,
        id: 'h-turn',
        from: 'Bob',
        body: 'lane 2',
        thread: 'h-root',
        meta: undefined,
        ts: T0 + 5_000,
      },
    });

    const team2 = (await getTeamBySlug(server.store, 'dawn'))!;
    await ingestTraceEvents(server.traceStore, team2.id, 'Bob', [
      {
        harness: 'claude-code',
        session_digest: 'abcdef012345',
        ts: T0 + 2_000,
        kind: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        outcome: 'ok',
        duration_ms: 900,
        detail: { command_head: 'git show origin/main:docs/demo/options.md' },
      } as any,
    ]);
  });

  afterEach(async () => {
    await server.close();
  });

  describe('GET /teams/:slug/huddles/:id/trace', () => {
    it('a named seat reads the joined timeline: seats, its turn, its tool step', async () => {
      const r = await call('GET', '/teams/dawn/huddles/h-root/trace', bobTok);
      expect(r.status).toBe(200);
      const t = HuddleTraceSchema.parse(r.json);
      expect(t.huddle).toMatchObject({ id: 'h-root', topic: 'goal:demo', opener: 'nick' });
      expect(t.seats.map((s) => [s.seat, s.summoned])).toEqual([
        ['nick', 'opener'],
        ['Bob', 'named'],
        ['Ada', 'named'],
      ]);
      expect(t.seats.find((s) => s.seat === 'Bob')).toMatchObject({
        time_to_turn_ms: 5_000,
        harness: 'claude-code',
      });
      const bash = t.events.find((e) => e.kind === 'tool');
      expect(bash).toEqual({
        ts: T0 + 2_000,
        seat: 'Bob',
        kind: 'tool',
        label: 'Bash',
        tool_name: 'Bash',
        outcome: 'ok',
        duration_ms: 900,
      });
      expect(JSON.stringify(r.json)).not.toContain('git show'); // structure only, never detail
    });

    it('the opener (an admin here) reads it too', async () => {
      expect((await call('GET', '/teams/dawn/huddles/h-root/trace', nickTok)).status).toBe(200);
    });

    it('a Member outside the room gets the same 404 as a huddle that does not exist', async () => {
      const outside = await call('GET', '/teams/dawn/huddles/h-root/trace', cyTok);
      const missing = await call('GET', '/teams/dawn/huddles/no-such/trace', cyTok);
      expect(outside.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(outside.json).toEqual(missing.json);
    });

    it('a turn id is not a huddle id: 404', async () => {
      expect((await call('GET', '/teams/dawn/huddles/h-turn/trace', bobTok)).status).toBe(404);
    });
  });
});
