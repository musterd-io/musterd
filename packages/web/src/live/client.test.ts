import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from '@musterd/protocol';
import {
  AuditFetchError,
  LiveFetchError,
  BroadcastSeatMissing,
  ObserverSignInRequired,
  acquireObserver,
  acquireWatchLinkObserver,
  broadcastSeat,
  createLane,
  fetchLaneBoard,
  fetchLaneChain,
  fetchLiveLaneBoard,
  fetchReport,
  fetchRoster,
  haltSeat,
  isStaleCredential,
  resumeSeat,
  updateLane,
} from './client';
import { fetchSeeds } from './seedClient';

describe('fetchSeeds', () => {
  const cfg = { team: 'revive', as: 'watcher', token: 'mscr_watch' };
  const row = {
    id: '01SEED00000000000000000000',
    team: 'revive',
    relay_id: 'relay-1',
    source: 'slack',
    body: 'Try a shared Seed tray',
    captured_at: 1,
    slack_user_id: 'U123',
    submitted_by: 'nick',
    state: 'open',
    explorer: null,
    thread: [],
    final_brief: null,
    conclusion: null,
    linked_lane_id: null,
    promotion: null,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
  };

  afterEach(() => vi.unstubAllGlobals());

  it('GETs the authenticated Team projection and parses every Seed', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ seeds: [row] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSeeds(cfg)).resolves.toEqual([row]);
    expect(fetchMock).toHaveBeenCalledWith('/teams/revive/seeds', {
      headers: { authorization: 'Bearer mscr_watch', 'x-musterd-surface': 'web' },
    });
  });

  it('rejects a malformed Seed instead of trusting the daemon body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ seeds: [{ id: 'only-an-id' }] }),
      })),
    );
    await expect(fetchSeeds(cfg)).rejects.toThrow();
  });
});

describe('isStaleCredential', () => {
  it('is true for a 401 LiveFetchError (the stale/invalid observer credential the daemon 401s)', () => {
    expect(isStaleCredential(new LiveFetchError('invalid human credential', 'unauthorized', 401))).toBe(
      true,
    );
  });

  it('is true for a 401 AuditFetchError (it IS a LiveFetchError subclass)', () => {
    expect(isStaleCredential(new AuditFetchError('no token', 'unauthorized', 401))).toBe(true);
  });

  it('is false for a 403 (forbidden — a real authz failure, not a stale credential to re-provision)', () => {
    expect(isStaleCredential(new LiveFetchError('forbidden', 'forbidden', 403))).toBe(false);
  });

  it('is false for a 500 or a plain Error (never auto-reprovision on a non-credential failure)', () => {
    expect(isStaleCredential(new LiveFetchError('boom', 'internal', 500))).toBe(false);
    expect(isStaleCredential(new Error('network down'))).toBe(false);
    expect(isStaleCredential('nope')).toBe(false);
    expect(isStaleCredential(null)).toBe(false);
  });
});

/**
 * `acquireObserver` is the ONLY way the broadcast route (ADR 157) resolves a credential — it has no
 * advanced-seat branch at all. That matters beyond tidiness: connecting as a real seat would attach a
 * *human* presence row and put a phantom person on the roster for as long as the stream runs (ADR 155).
 * So: it reads the observer key and nothing else, whatever else the browser has stored.
 */
/**
 * ADR 601 decision 7: /broadcast only ever watches with the seat its capturer handed it. The
 * fallback it used to have, `acquireObserver`, returns this browser's cached observer, which is
 * full-grade (every DM, unmasked). A stream must never run on that.
 */
describe('broadcastSeat (ADR 601: the handed seat or nothing)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const browser = (globals: Record<string, unknown>) =>
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) =>
          k === 'musterd.live.observer.v2.revive'
            ? JSON.stringify({ name: 'web-full01', token: 'mscr_full' })
            : null,
        setItem: () => {},
        removeItem: () => {},
      },
      ...globals,
    });

  it('returns the seat the capturer handed over', () => {
    browser({ __musterdBroadcastSeat: { team: 'revive', name: 'broadcast-ab12cd', token: 'mscr_b' } });
    expect(broadcastSeat('revive')).toEqual({
      team: 'revive',
      as: 'broadcast-ab12cd',
      token: 'mscr_b',
    });
  });

  it('refuses without a handed seat, even with a cached full-grade observer, and sends nothing', () => {
    browser({});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(() => broadcastSeat('revive')).toThrow(BroadcastSeatMissing);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a seat handed over for another team', () => {
    browser({ __musterdBroadcastSeat: { team: 'bench', name: 'broadcast-x', token: 'mscr_x' } });
    expect(() => broadcastSeat('revive')).toThrow(BroadcastSeatMissing);
  });
});

describe('acquireObserver (the observer-only path broadcast mode relies on)', () => {
  const store = (entries: Record<string, string>) => {
    const map = new Map(Object.entries(entries));
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    });
    return map;
  };

  afterEach(() => vi.unstubAllGlobals());

  it('returns the cached observer seat without provisioning anything', async () => {
    store({
      'musterd.live.observer.v2.revive': JSON.stringify({ name: 'web-a1b2c3', token: 'mscr_obs' }),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(acquireObserver('revive')).resolves.toEqual({
      team: 'revive',
      as: 'web-a1b2c3',
      token: 'mscr_obs',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores every other stored credential — a seat key or a watch-link seat is never picked up', async () => {
    store({
      'musterd.live.observer.v2.revive': JSON.stringify({ name: 'web-a1b2c3', token: 'mscr_obs' }),
      // a real agent key + a shared watch-link seat, both sitting in the same localStorage
      'musterd.agent.key': 'mskey_seat_credential',
      'musterd.live.watchlink.v1.revive': JSON.stringify({ name: 'watch-zz', token: 'mscr_pub' }),
    });
    const cfg = await acquireObserver('revive');
    expect(cfg.as).toBe('web-a1b2c3');
    expect(cfg.token).toBe('mscr_obs');
  });

  it('is scoped per team — another team’s cached observer is not reused', async () => {
    store({
      'musterd.live.observer.v2.other': JSON.stringify({ name: 'web-other', token: 'mscr_other' }),
    });
    // no cached observer for `revive` → it must provision one rather than borrow the other team's
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ human_credential: 'mscr_fresh' }),
      })),
    );
    const cfg = await acquireObserver('revive', 'mscr_admin');
    expect(cfg.team).toBe('revive');
    expect(cfg.token).toBe('mscr_fresh');
    expect(cfg.as).not.toBe('web-other');
  });

  // ADR 580: loopback no longer provisions an observer, so a page with no credential must not even
  // try — the daemon would 401 and the viewer would read the server's refusal as the page's answer.
  it('with nothing cached and no credential, asks for a sign-in and sends nothing', async () => {
    store({});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(acquireObserver('revive')).rejects.toBeInstanceOf(ObserverSignInRequired);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mints with the signed-in human’s credential and caches the seat', async () => {
    const map = store({});
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ human_credential: 'mscr_fresh' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const cfg = await acquireObserver('revive', 'mscr_admin');
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mscr_admin');
    expect(JSON.parse(init.body as string)).toMatchObject({ observer: true, observer_scope: 'full' });
    expect(JSON.parse(map.get('musterd.live.observer.v2.revive')!)).toEqual({
      name: cfg.as,
      token: 'mscr_fresh',
    });
  });
});

describe('acquireWatchLinkObserver (ADR 580: minted by a signed-in human, public-grade)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = (entries: Record<string, string>) => {
    const map = new Map(Object.entries(entries));
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    });
    return map;
  };

  it('reuses the cached link seat without a credential or a request', async () => {
    store({
      'musterd.live.watchlink.v1.revive': JSON.stringify({ name: 'watch-zz', token: 'mscr_pub' }),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(acquireWatchLinkObserver('revive', null)).resolves.toEqual({
      name: 'watch-zz',
      token: 'mscr_pub',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with nothing cached and no credential, asks for a sign-in and sends nothing', async () => {
    store({});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(acquireWatchLinkObserver('revive', null)).rejects.toBeInstanceOf(
      ObserverSignInRequired,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mints a public-grade seat with the member credential', async () => {
    store({});
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ human_credential: 'mscr_pub' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    await acquireWatchLinkObserver('revive', 'mscr_admin');
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mscr_admin');
    expect(JSON.parse(init.body as string)).toMatchObject({ observer_scope: 'public' });
  });

  // ADR 616: a demo link is its own broadcast-grade seat. A cached public seat must never answer for
  // it, or a "demo" link would quietly show nothing directed; and the reverse would hand a casual
  // public share the broadcast seat's credential.
  it('mints a separate broadcast-grade seat for a demo link, ignoring the cached public one', async () => {
    const map = store({
      'musterd.live.watchlink.v1.revive': JSON.stringify({ name: 'watch-zz', token: 'mscr_pub' }),
    });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ human_credential: 'mscr_demo' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const demo = await acquireWatchLinkObserver('revive', 'mscr_admin', 'broadcast');
    expect(demo.token).toBe('mscr_demo');
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ observer_scope: 'broadcast' });
    expect(map.get('musterd.live.watchlink.v1.revive')).toContain('mscr_pub');
    expect(map.get('musterd.live.watchlink.broadcast.v1.revive')).toContain('mscr_demo');
    await expect(acquireWatchLinkObserver('revive', null)).resolves.toMatchObject({
      token: 'mscr_pub',
    });
  });
});

/**
 * The writable board's two mutations (item 5 / ADR 104). Member-authed POST/PATCH — a browser lane
 * mutation is indistinguishable from a CLI one to the daemon, which is also why the client must NOT
 * send any companion act: the daemon emits the `lane_open`/`lane_claim`/… team acts itself.
 */
describe('createLane / updateLane (the writable board, item 5)', () => {
  const cfg = { team: 'revive', as: 'nick', token: 'mscr_nick' };

  const lane = (over: Partial<Lane> = {}): Lane => ({
    id: 'L1',
    team: 'revive',
    project: 'default',
    title: 'write the launch post',
    detail: null,
    owner_seat: 'nick',
    role: null,
    scope: [],
    areas: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    risk: [],
    stakes: 'normal' as const,
    stakes_provenance: 'declared' as const,
    merged: null,
    state: 'claimed',
    created_by: 'nick',
    created_at: 1,
    claimed_at: 1,
    resolved_at: null,
    updated_at: 1,
    ...over,
  });

  const okJson = (body: unknown, status = 200) =>
    ({ ok: true, status, text: async () => JSON.stringify(body) }) as Response;
  const errJson = (status: number, code: string, message: string) =>
    ({
      ok: false,
      status,
      text: async () => JSON.stringify({ error: { code, message } }),
    }) as Response;

  afterEach(() => vi.unstubAllGlobals());

  it('createLane POSTs the OpenLane body as the signed-in member and returns the parsed result', async () => {
    const fetchMock = vi.fn(async () => okJson({ lane: lane(), warnings: [] }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createLane(cfg, { title: 'write the launch post', claim: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/teams/revive/lanes');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer mscr_nick');
    expect(headers['x-musterd-surface']).toBe('web');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'write the launch post', claim: true });
    expect(result.lane.owner_seat).toBe('nick');
    expect(result.warnings).toEqual([]);
  });

  it('createLane throws a LiveFetchError carrying the daemon code (so isStaleCredential still works)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errJson(403, 'forbidden', 'observers cannot open lanes')),
    );
    await expect(createLane(cfg, { title: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
      message: 'observers cannot open lanes',
    });
    vi.stubGlobal('fetch', vi.fn(async () => errJson(401, 'unauthorized', 'stale')));
    await expect(createLane(cfg, { title: 'x' })).rejects.toSatisfy(isStaleCredential);
  });

  it('updateLane PATCHes /lanes/:id (id URL-encoded) and returns the updated lane + fresh warnings', async () => {
    const warning = {
      kind: 'surface_overlap' as const,
      subject: 'L1',
      with: 'L2',
      owner: 'stanley',
      detail: 'overlaps packages/web/**',
    };
    const fetchMock = vi.fn(async () =>
      okJson({ lane: lane({ state: 'active' }), warnings: [warning] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateLane(cfg, 'L 1', { state: 'active' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/teams/revive/lanes/L%201');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ state: 'active' });
    expect(result.lane.state).toBe('active');
    expect(result.warnings).toEqual([warning]);
  });

  // live-loads-fast inc 1 (lane 01M4RNCZVB): /live asks for brief rows (no detail — it never shows
  // one) and for every state but abandoned (nothing on /live shows those either).
  it('fetchLaneChain reads GET /lanes/:id into the five links', async () => {
    const fetchMock = vi.fn(async () =>
      okJson({
        lane: {
          owner_seat: 'TJ',
          requested: { by: 'big-body', basis: 'stated' },
          merged: null,
        },
        history: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const links = await fetchLaneChain(cfg, '01M534RA2H');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/teams/revive/lanes/01M534RA2H');
    expect(links.map((link) => link.mark)).toEqual([
      'stated',
      'verified',
      'missing',
      'missing',
      'missing',
    ]);
    expect(links[0]).toMatchObject({ link: 'asked', value: 'big-body' });
    expect(links[1]).toMatchObject({ link: 'claimed', value: 'TJ' });
  });

  it('fetchLaneBoard passes brief=1 and the repeatable ?state= filter', async () => {
    const fetchMock = vi.fn(async () => okJson({ lanes: [], warnings: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchLaneBoard(cfg, { brief: true, states: ['open', 'done'] });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('/teams/revive/lanes?brief=1&state=open&state=done');
    fetchMock.mockClear();
    await fetchLaneBoard(cfg);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/teams/revive/lanes');
  });

  // The daemon may be a build behind the bundle for a minute after a merge (the publisher and the
  // autorefresher run apart): a 400 on `brief` falls back to the full read, never to an empty board.
  it('fetchLiveLaneBoard falls back to the full read when the daemon does not know brief=1', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => errJson(400, 'bad_request', 'unknown brief "1"'))
      .mockImplementationOnce(async () => okJson({ lanes: [lane()], warnings: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const board = await fetchLiveLaneBoard(cfg);
    expect(board.lanes).toHaveLength(1);
    const urls = fetchMock.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls[0]).toMatch(/brief=1/);
    expect(urls[1]).toBe('/teams/revive/lanes');
  });

  it('rejects a malformed daemon body at the boundary (schema parse, like fetchLaneBoard)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ lane: { id: 'L1' } })));
    await expect(updateLane(cfg, 'L1', { state: 'active' })).rejects.toThrow();
  });

  it('fetchReport GETs /teams/:slug/report member-authed and parses at the boundary', async () => {
    const report = {
      team: 'revive',
      generated_ts: 1,
      flow: { throughput_7d: 3, cycle_time_ms: null, wip: 2, oldest_wip_age_ms: 5000 },
      waiting_on: [{ member: 'nick', threads: 8, oldest_age_ms: 172800000 }],
      goals: [],
      blocked: [{ id: 'L1', title: 'write the launch post', owner_seat: 'nick', goal_id: null }],
      coordination: {
        window_days: 7,
        acts: 10,
        journal: 2,
        directed: 5,
        threaded: 3,
        journal_ratio: 0.2,
        exchange_ratio: 0.8,
        flag: false,
      },
      open_directed: [],
      mast: {
        window_days: 7,
        time_to_unblock: { closed: 0, median_ms: null, p95_ms: null },
        ignored_help: [],
        stalled_threads: [],
        circular_handoffs: [],
        diversity: [],
      },
      steering: {
        window_days: 7,
        steers: 0,
        acked: 0,
        latency_median_ms: null,
        latency_p95_ms: null,
        superseded_acts: 0,
        stale_wakes: 0,
        stale_caught: 0,
      },
    };
    const fetchMock = vi.fn(async () => okJson(report));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchReport(cfg);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/teams/revive/report');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mscr_nick');
    expect(out.waiting_on[0]!.member).toBe('nick');
    expect(out.flow.wip).toBe(2);
  });
});

/**
 * The roster read is the page's single point of failure (lane 01KZ9EJCHD): `MemberSummarySchema.array()`
 * is strict, so ONE row carrying a `kind`/`surface`/`offline_reason` value this bundle predates threw the
 * WHOLE array — and `useLiveStream` turned that into an error banner instead of a room. That is the exact
 * opposite of ADR 148's premise, where a client behind the daemon degrades calmly and keeps rendering.
 * It fired for real on ADR 232's `kind: 'service'`, and it would fire again for every future enum value.
 *
 * So the read path parses each member INDEPENDENTLY and reports what it could not read. The write path
 * is untouched and must stay strict — tolerating an unknown value on ingest is how bad data gets durable.
 */
describe('fetchRoster (forward-tolerance: one unreadable seat must not cost the page)', () => {
  const cfg = { team: 'revive', as: 'nick', token: 'mscr_nick' };
  const okJson = (body: unknown) =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

  const member = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    team: 'revive',
    name: 'miley',
    kind: 'agent',
    role: '',
    roles: [],
    lifecycle: 'forever',
    created_at: 1,
    presence: 'online',
    presences: [],
    ...over,
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps the seats it understands and counts the ones it does not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson({
          members: [
            member({ id: 'm1', name: 'miley' }),
            // A kind this bundle predates — exactly ADR 232's `service`, from the daemon's future.
            member({ id: 'm2', name: 'autorefresh', kind: 'wormhole' }),
            member({ id: 'm3', name: 'izzo' }),
          ],
          team: {},
        }),
      ),
    );
    const out = await fetchRoster(cfg);
    expect(out.members.map((m) => m.name)).toEqual(['miley', 'izzo']);
    expect(out.unreadable).toBe(1);
  });

  it('reports zero unreadable when every row parses (no false alarm on a matched build)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ members: [member()], team: {} })));
    const out = await fetchRoster(cfg);
    expect(out.members).toHaveLength(1);
    expect(out.unreadable).toBe(0);
  });

  it('still throws when the response is not a roster at all — tolerance is per-row, not blanket', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ members: 'nope' })));
    await expect(fetchRoster(cfg)).rejects.toThrow();
  });
});

describe('haltSeat / resumeSeat (ADR 501)', () => {
  const cfg = { team: 'dawn', as: 'nick', token: 'mscr_x' };
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the reason to the halt route as the web surface', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ member: 'Ada', halted: { at: 1, by: 'nick', reason: 'x' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await haltSeat(cfg, 'Ada', 'x');
    expect(res.halted.by).toBe('nick');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/teams/dawn/members/Ada/halt');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'x' });
    expect((init.headers as Record<string, string>)['x-musterd-surface']).toBe('web');
  });

  it('surfaces the daemon refusal (who may halt is decided there) as a LiveFetchError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({ error: { code: 'forbidden', message: 'you may halt only agents you sponsor' } }),
      })),
    );
    await expect(resumeSeat(cfg, 'Ada')).rejects.toMatchObject({
      status: 403,
      message: 'you may halt only agents you sponsor',
    });
  });
});
