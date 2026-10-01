import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchRoster, fetchRosters, liveFor, rosterKey, teamAgents } from './live.js';
import type { Seat } from './store.js';

const seat = (over: Partial<Seat> = {}): Seat => ({
  address: 'acme/proj/ada',
  team: 'acme',
  project: 'proj',
  member: 'ada',
  server: 'http://127.0.0.1:4849',
  path: '/w/ada',
  kind: 'agent',
  harnesses: [],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});
const member = (name: string, kind: 'agent' | 'human', presences: unknown[] = []) => ({
  id: `m-${name}`,
  team: 'acme',
  name,
  kind,
  created_at: 1,
  presence: presences.length ? 'online' : 'offline',
  presences,
});
const roster = {
  members: [
    member('ada', 'agent', [
      { surface: 'claude-code', status: 'online', last_seen_at: 9, attached_at: 5_000 },
    ]),
    member('bo', 'agent', [
      {
        surface: 'codex',
        status: 'online',
        last_seen_at: 9,
        attached_at: 6_000,
        node: 'n1',
        node_label: 'mini-2',
      },
    ]),
    member('nick', 'human'),
    member('cy', 'agent'),
  ],
};
const okFetch = (async () =>
  new Response(JSON.stringify(roster), { status: 200 })) as unknown as typeof fetch;

let server: Server | undefined;
afterEach(() => server?.close());

describe('the roster read (ADR 491)', () => {
  it('parses members through the protocol schema', async () => {
    const members = await fetchRoster('http://127.0.0.1:4849', 'acme', 300, okFetch);
    expect(members?.map((m) => m.name)).toEqual(['ada', 'bo', 'nick', 'cy']);
  });

  it('answers null for a refused, non-JSON or off-schema answer', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const html = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    const bad = (async () =>
      new Response('{"members":[{"x":1}]}', { status: 200 })) as unknown as typeof fetch;
    const notOk = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    for (const f of [refused, html, bad, notOk])
      expect(await fetchRoster('http://x', 'acme', 300, f)).toBeNull();
  });

  it('gives up on a wedged daemon at its time box', async () => {
    server = createServer(() => {
      /* accept the request, never answer */
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const t0 = Date.now();
    expect(await fetchRoster(`http://127.0.0.1:${port}`, 'acme', 80)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('reads each (server, team) once', async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(roster), { status: 200 });
    }) as unknown as typeof fetch;
    const seats = [
      seat(),
      seat({ address: 'acme/proj/bo', member: 'bo' }),
      seat({ server: 'http://localhost:4849/' }),
    ];
    const rosters = await fetchRosters(seats, 300, counting);
    expect(calls).toBe(1);
    expect(rosters.get(rosterKey(seats[0]!))?.length).toBe(4);
  });
});

describe('liveFor', () => {
  it('a Presence on the loopback daemon with no node is here', () => {
    expect(liveFor(seat(), roster.members as never)).toEqual({
      where: 'here',
      label: 'here',
      surface: 'claude-code',
      since: 5_000,
    });
  });

  it('a Presence on another node names that node', () => {
    expect(liveFor(seat({ member: 'bo' }), roster.members as never)).toEqual({
      where: 'elsewhere',
      label: 'mini-2',
      surface: 'codex',
      since: 6_000,
    });
  });

  it('no Presence, no roster, or no member is not live', () => {
    expect(liveFor(seat({ member: 'cy' }), roster.members as never)).toBeNull();
    expect(liveFor(seat(), null)).toBeNull();
    expect(liveFor(seat({ member: 'zz' }), roster.members as never)).toBeNull();
  });
});

describe('teamAgents', () => {
  it('lists agent members only, sorted', () => {
    expect(teamAgents(roster.members as never)).toEqual(['ada', 'bo', 'cy']);
  });
});
