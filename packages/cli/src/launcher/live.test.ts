import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canOf,
  fetchRoster,
  fetchRosterPage,
  fetchRosters,
  liveFor,
  rosterKey,
  rosterTargets,
  teamAgents,
  teamRows,
  whereOf,
} from './live.js';
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
    const rosters = await fetchRosters(rosterTargets(seats, [], ''), 300, counting);
    expect(calls).toBe(1);
    expect(rosters.get(rosterKey(seats[0]!))?.members.length).toBe(4);
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

  it('a woken Presence carries why; one a person opened carries no wake at all (ADR 543)', () => {
    const wake_for = {
      edge: 'review',
      lane_id: '01M49MEFFRNKSZ0KAYXVY96BTR',
      act_id: 'a1',
      act: 'ask',
      from: 'ghost',
    };
    const woken = [
      member('ada', 'agent', [
        {
          surface: 'claude-code',
          status: 'online',
          last_seen_at: 1,
          attached_at: 5_000,
          provenance: 'wake',
          wake_for,
        },
      ]),
    ];
    expect(liveFor(seat(), woken as never)?.wake).toEqual(wake_for);
    const unexplained = [
      member('ada', 'agent', [
        { surface: 'claude-code', status: 'online', last_seen_at: 1, provenance: 'wake' },
      ]),
    ];
    expect(liveFor(seat(), unexplained as never)?.wake).toBeNull();
    expect(liveFor(seat(), roster.members as never)).not.toHaveProperty('wake');
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

describe('the roster page carries the answering node (ADR 503 §4)', () => {
  it('reads node from the page and tolerates its absence', async () => {
    const withNode = (async () =>
      new Response(JSON.stringify({ ...roster, node: { id: 'n-hub', label: 'mac' } }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect((await fetchRosterPage('http://127.0.0.1:4849', 'acme', 300, withNode))?.node).toEqual({
      id: 'n-hub',
      label: 'mac',
    });
    expect((await fetchRosterPage('http://127.0.0.1:4849', 'acme', 300, okFetch))?.node).toBeNull();
  });

  it('rosterTargets adds the default server for a team known only by identity', () => {
    const targets = rosterTargets(
      [seat()],
      [
        { team: 'acme', here: true },
        { team: 'dawn', here: false },
      ],
      'http://127.0.0.1:4849',
    );
    expect(targets).toEqual([
      { server: 'http://127.0.0.1:4849', team: 'acme' },
      { server: 'http://127.0.0.1:4849', team: 'dawn' },
    ]);
    expect(rosterTargets([], [{ team: 'dawn', here: false }], '')).toEqual([]);
  });
});

describe('where / can (ADR 503 Decision 2)', () => {
  const hub = { id: 'n-hub', label: 'mac' };
  const loop = 'http://127.0.0.1:4849';
  const m = (over: Record<string, unknown>) =>
    ({ ...member('x', 'agent'), presences: [], ...over }) as never;
  const residence = (node: string, kind: 'node' | 'cloud' = 'node') => ({
    node,
    node_label: node === 'n-hub' ? 'mac' : 'air-2',
    kind,
  });

  it('residence decides first: here on this node, node elsewhere, cloud', () => {
    expect(whereOf(m({ residence: residence('n-hub') }), hub, loop)).toEqual({
      where: 'here',
      node: 'n-hub',
      label: null,
    });
    expect(whereOf(m({ residence: residence('n-air') }), hub, loop)).toEqual({
      where: 'node',
      node: 'n-air',
      label: 'air-2',
    });
    expect(whereOf(m({ residence: residence('n-fly', 'cloud') }), hub, loop).where).toBe('cloud');
    // The same residence read from a non-loopback server is never "here".
    expect(whereOf(m({ residence: residence('n-hub') }), hub, 'https://musterd.io').where).toBe(
      'node',
    );
  });

  it('without a residence, a live presence places the seat; nothing places it nowhere', () => {
    const local = { surface: 'claude-code', status: 'online', last_seen_at: 1 };
    expect(whereOf(m({ presences: [local] }), hub, loop).where).toBe('here');
    expect(
      whereOf(m({ presences: [{ ...local, node: 'n-air', node_label: 'air-2' }] }), hub, loop),
    ).toEqual({ where: 'node', node: 'n-air', label: 'air-2' });
    expect(whereOf(m({}), hub, loop)).toEqual({ where: 'nowhere', node: null, label: null });
  });

  const nick = { ...member('nick', 'human'), roles: [] } as never;
  const admin = { ...member('nick', 'human'), roles: ['admin'] } as never;
  const placed = (where: 'here' | 'node' | 'cloud' | 'nowhere') => ({
    where,
    node: null,
    label: null,
  });

  it('launch: a Workspace here and the seat here or nowhere', () => {
    expect(
      canOf(m({}), { placed: placed('here'), workspace: true, viewer: nick, viewerSeatHere: true }),
    ).toBe('launch');
    expect(
      canOf(m({}), {
        placed: placed('nowhere'),
        workspace: true,
        viewer: null,
        viewerSeatHere: false,
      }),
    ).toBe('launch');
  });

  it('wake: resident elsewhere, wake-enrolled, and the viewer sponsors it or is an admin', () => {
    const mine = m({ wakeable: true, sponsored_by: 'm-nick' });
    expect(
      canOf(mine, { placed: placed('node'), workspace: false, viewer: nick, viewerSeatHere: true }),
    ).toBe('wake');
    expect(
      canOf(mine, { placed: placed('cloud'), workspace: true, viewer: nick, viewerSeatHere: true }),
    ).toBe('wake');
    const theirs = m({ wakeable: true, sponsored_by: 'm-other' });
    expect(
      canOf(theirs, {
        placed: placed('node'),
        workspace: false,
        viewer: nick,
        viewerSeatHere: true,
      }),
    ).toBe('none');
    expect(
      canOf(theirs, {
        placed: placed('node'),
        workspace: false,
        viewer: admin,
        viewerSeatHere: true,
      }),
    ).toBe('wake');
    const notEnrolled = m({ wakeable: false, sponsored_by: 'm-nick' });
    expect(
      canOf(notEnrolled, {
        placed: placed('node'),
        workspace: false,
        viewer: nick,
        viewerSeatHere: true,
      }),
    ).toBe('none');
    // A human resident elsewhere is their own sponsor.
    expect(
      canOf(
        { ...nick, wakeable: true },
        { placed: placed('node'), workspace: false, viewer: nick, viewerSeatHere: true },
      ),
    ).toBe('wake');
  });

  it('a service seat is never set up from the front door (ADR 509)', () => {
    const svc = { ...member('digest', 'agent'), kind: 'service', presences: [] } as never;
    expect(
      canOf(svc, {
        placed: placed('nowhere'),
        workspace: false,
        viewer: nick,
        viewerSeatHere: true,
      }),
    ).toBe('none');
  });

  it('setup only for a seat that lives nowhere, has no folder here, and a viewer with a seat here', () => {
    expect(
      canOf(m({}), {
        placed: placed('nowhere'),
        workspace: false,
        viewer: nick,
        viewerSeatHere: true,
      }),
    ).toBe('setup');
    expect(
      canOf(m({}), {
        placed: placed('nowhere'),
        workspace: false,
        viewer: nick,
        viewerSeatHere: false,
      }),
    ).toBe('none');
    // NEVER setup for a seat resident on another node — that is a move (ADR 503 Decision 2).
    expect(
      canOf(m({}), {
        placed: placed('node'),
        workspace: false,
        viewer: nick,
        viewerSeatHere: true,
      }),
    ).toBe('none');
  });

  it('teamRows: every member once, overlaid with the Workspaces here, sorted', () => {
    const page = {
      node: hub,
      members: [
        m({ name: 'ada', id: 'm-ada', residence: residence('n-hub'), wakeable: true }),
        m({
          name: 'bo',
          id: 'm-bo',
          residence: residence('n-air'),
          wakeable: true,
          sponsored_by: 'm-nick',
        }),
        m({ name: 'cy', id: 'm-cy' }),
        { ...nick, id: 'm-nick' },
      ],
    } as never;
    const seats = [
      seat(),
      seat({ address: 'acme/proj/nick', member: 'nick', kind: 'human', path: '/w/nick' }),
    ];
    const rows = teamRows('acme', page, loop, seats, 'nick');
    expect(rows.map((r) => [r.member, r.address, r.where, r.where_label, r.can])).toEqual([
      ['ada', 'acme/proj/ada', 'here', null, 'launch'],
      ['bo', null, 'node', 'air-2', 'wake'],
      ['cy', null, 'nowhere', null, 'setup'],
      ['nick', 'acme/proj/nick', 'nowhere', null, 'launch'],
    ]);
  });
});
