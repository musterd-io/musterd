import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { GENERALIST_CAPABILITIES, PROTOCOL_VERSION } from '@musterd/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { bootCloud } from '../cloud/testing.js';
import { testIssuer, type TestIssuer } from '../cloud/testIssuer.js';
import type { Driver } from '../db/driver.js';
import { openTestDriver } from '../db/testing.js';
import { createServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { __setInviteKeyForTest, mintInvite } from '../store/invites.js';
import {
  addMember,
  bindMemberAccount,
  mintCredential,
  setMemberGovernance,
} from '../store/members.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { createTeam } from '../store/teams.js';
import { SESSION_COOKIE, SIGNIN_COOKIE, SIGNED_OUT_CLOSE_CODE } from './liveSession.js';

/**
 * ADR 722 §1–4 against a real Cloud server and the test issuer: the falsifier list in its
 * Observability section, route by route. Every refused callback must leave no session row.
 */

const AUD = 'https://cloud.test';
const HOST = 'revive.musterd.test';
const TEAM_ORIGIN = `https://${HOST}`;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let issuer: TestIssuer;
beforeAll(async () => {
  issuer = testIssuer();
  await issuer.serve();
});
afterAll(async () => {
  await issuer.close();
});

describe('hosted /live sign-in (ADR 722)', () => {
  let s: Awaited<ReturnType<typeof bootCloud>>['s'];
  let url: string;
  let seed: Driver;
  let team: TeamRow;
  let ada: MemberRow;
  let adaCred: string;
  let consoleOrigin: string;

  beforeEach(async () => {
    __setInviteKeyForTest(randomBytes(32));
    const booted = await bootCloud({ MUSTERD_CONSOLE_JWKS_URL: issuer.url });
    s = booted.s;
    url = booted.url;
    seed = booted.seed!;
    consoleOrigin = new URL(issuer.url).origin;
    team = await createTeam(seed, { slug: 'revive' });
    ada = (await addMember(seed, team, { name: 'ada', kind: 'human', role: '' })).row;
    adaCred = (await mintCredential(seed, ada.id)).credential;
    await bindMemberAccount(seed, ada.id, 'acct_ada');
  });
  afterEach(async () => {
    await s.close();
    vi.unstubAllEnvs();
    __setInviteKeyForTest(null);
  });

  function call(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: string; host?: string } = {},
  ): Promise<Res> {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const r = request(
        {
          host: u.hostname,
          port: u.port,
          path,
          method,
          headers: { host: opts.host ?? HOST, 'x-forwarded-proto': 'https', ...opts.headers },
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      r.on('error', reject);
      r.end(opts.body);
    });
  }

  const cookies = (r: Res): string[] => {
    const h = r.headers['set-cookie'];
    return Array.isArray(h) ? h : h ? [h] : [];
  };
  const cookieValue = (r: Res, name: string): string | undefined =>
    cookies(r)
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0]!
      .slice(name.length + 1);

  async function startSignin(path = '/live/signin/start'): Promise<string> {
    const r = await call('GET', path);
    expect(r.status).toBe(303);
    const state = cookieValue(r, SIGNIN_COOKIE)!;
    expect(state).toBeTruthy();
    return state;
  }

  function statement(sub = 'acct_ada', over: Record<string, unknown> = {}): string {
    return issuer.token(AUD, { sub, email: `${sub}@example.test`, ...over });
  }

  function postCallback(
    form: { state?: string; statement?: string },
    opts: { cookieState?: string | null; origin?: string } = {},
  ): Promise<Res> {
    const body = new URLSearchParams(
      Object.entries(form).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      origin: opts.origin ?? consoleOrigin,
    };
    if (opts.cookieState !== null && (opts.cookieState ?? form.state))
      headers['cookie'] = `${SIGNIN_COOKIE}=${opts.cookieState ?? form.state}`;
    return call('POST', '/live/signin/callback', { headers, body });
  }

  async function signIn(sub = 'acct_ada'): Promise<string> {
    const state = await startSignin();
    const r = await postCallback({ state, statement: statement(sub) });
    expect(r.status).toBe(303);
    return cookieValue(r, SESSION_COOKIE)!;
  }

  function exchange(sessionCookie: string | null, over: Record<string, string> = {}): Promise<Res> {
    return call('POST', '/live/session/token', {
      headers: {
        origin: TEAM_ORIGIN,
        'sec-fetch-site': 'same-origin',
        ...(sessionCookie ? { cookie: `${SESSION_COOKIE}=${sessionCookie}` } : {}),
        ...over,
      },
    });
  }

  const sessionRows = async () =>
    (await seed.get<{ n: number }>('SELECT COUNT(*) AS n FROM browser_sessions', []))!.n;
  const refusals = async () =>
    (await listAudit(seed, team.id))
      .filter((a) => a.action === 'session.refused')
      .map((a) => (JSON.parse(String(a.detail ?? '{}')) as { reason: string }).reason);

  it('start sends the browser to the console with a one-time state in a __Host- SameSite=None cookie', async () => {
    const r = await call('GET', '/live/signin/start');
    expect(r.status).toBe(303);
    const loc = new URL(String(r.headers['location']));
    expect(loc.origin).toBe(consoleOrigin);
    expect(loc.pathname).toBe('/handback');
    expect(loc.searchParams.get('aud')).toBe(AUD);
    expect(loc.searchParams.get('team')).toBe('revive');
    const c = cookies(r).find((x) => x.startsWith(`${SIGNIN_COOKIE}=`))!;
    expect(loc.searchParams.get('state')).toBe(cookieValue(r, SIGNIN_COOKIE));
    for (const attr of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=None', 'Max-Age=600'])
      expect(c).toContain(attr);
    expect(c).not.toMatch(/Domain=/i);
  });

  it('the callback signs a bound account in: a __Host- Lax session cookie, the signin cookie cleared', async () => {
    const state = await startSignin();
    const r = await postCallback({ state, statement: statement() });
    expect(r.status).toBe(303);
    expect(r.headers['location']).toBe('/live');
    const sc = cookies(r).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(sc.split(';')[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=mbs_`));
    for (const attr of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax']) expect(sc).toContain(attr);
    expect(sc).not.toMatch(/Domain=/i);
    expect(cookies(r).find((c) => c.startsWith(`${SIGNIN_COOKIE}=`))).toContain('Max-Age=0');
    expect(await sessionRows()).toBe(1);
    const audit = (await listAudit(seed, team.id)).find((a) => a.action === 'session.created')!;
    expect(audit.actor).toBe('ada');
    expect(JSON.stringify(audit)).not.toContain('acct_ada');
  });

  it('refuses each forged or stale callback and leaves no session row', async () => {
    // State mismatch: the form names a state the cookie does not.
    const a = await startSignin();
    expect(
      (await postCallback({ state: a, statement: statement() }, { cookieState: 'x' })).status,
    ).toBe(403);
    // Missing signin cookie.
    const b = await startSignin();
    expect(
      (await postCallback({ state: b, statement: statement() }, { cookieState: null })).status,
    ).toBe(403);
    // Unknown state record (cookie and form agree on a state the server never wrote).
    expect((await postCallback({ state: 'never-written', statement: statement() })).status).toBe(
      403,
    );
    // Expired state record.
    const c = await startSignin();
    await seed.run('UPDATE signin_states SET expires_at = 1');
    expect((await postCallback({ state: c, statement: statement() })).status).toBe(403);
    // A foreign Origin.
    const d = await startSignin();
    expect(
      (await postCallback({ state: d, statement: statement() }, { origin: 'https://evil.test' }))
        .status,
    ).toBe(403);
    // The wrong aud.
    const e = await startSignin();
    expect(
      (
        await postCallback({
          state: e,
          statement: issuer.token('https://other.test', { sub: 'acct_ada', email: 'a@x' }),
        })
      ).status,
    ).toBe(403);
    // An unbound account: the page says so without naming anyone.
    const f = await startSignin();
    const unbound = await postCallback({ state: f, statement: statement('acct_stranger') });
    expect(unbound.status).toBe(403);
    expect(unbound.body).toContain("isn't on this team yet");
    expect(unbound.body).not.toContain('ada');
    expect(await sessionRows()).toBe(0);
    expect(await refusals()).toEqual(
      expect.arrayContaining([
        'state_mismatch',
        'no_cookie',
        'state_unknown',
        'state_expired',
        'origin',
        'statement',
        'unbound',
      ]),
    );
  });

  it('the start route is charged to the host team’s request budget', async () => {
    await s.close();
    vi.unstubAllEnvs();
    const booted = await bootCloud({
      MUSTERD_CONSOLE_JWKS_URL: issuer.url,
      MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN: '2',
    });
    s = booted.s;
    url = booted.url;
    await createTeam(booted.seed!, { slug: 'budget' });
    const host = 'budget.musterd.test';
    expect((await call('GET', '/live/signin/start', { host })).status).toBe(303);
    expect((await call('GET', '/live/signin/start', { host })).status).toBe(303);
    const third = await call('GET', '/live/signin/start', { host });
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBe('60');
  });

  it('a state works once, and a statement works once', async () => {
    const state = await startSignin();
    const st = statement();
    expect((await postCallback({ state, statement: st })).status).toBe(303);
    expect((await postCallback({ state, statement: statement() })).status).toBe(403); // spent state
    const again = await startSignin();
    expect((await postCallback({ state: again, statement: st })).status).toBe(403); // replayed jti
    expect(await sessionRows()).toBe(1);
  });

  it('refuses a member who has left since binding', async () => {
    await seed.run('UPDATE members SET left_at = ? WHERE id = ?', [Date.now(), ada.id]);
    const state = await startSignin();
    expect((await postCallback({ state, statement: statement() })).status).toBe(403);
    expect(await sessionRows()).toBe(0);
  });

  describe('link (§2)', () => {
    let bob: MemberRow;
    let bobCred: string;
    beforeEach(async () => {
      bob = (await addMember(seed, team, { name: 'bob', kind: 'human', role: '' })).row;
      bobCred = (await mintCredential(seed, bob.id)).credential;
    });
    const startLink = (cred?: string) =>
      call('POST', '/live/signin/start', {
        headers: {
          'content-type': 'application/json',
          ...(cred ? { authorization: `Bearer ${cred}` } : {}),
        },
        body: JSON.stringify({ mode: 'link' }),
      });

    it('binds the account to the member pinned at start and signs them in', async () => {
      const r = await startLink(bobCred);
      expect(r.status).toBe(200);
      const state = cookieValue(r, SIGNIN_COOKIE)!;
      expect(new URL((JSON.parse(r.body) as { url: string }).url).searchParams.get('state')).toBe(
        state,
      );
      const cb = await postCallback({ state, statement: statement('acct_bob') });
      expect(cb.status).toBe(303);
      const row = await seed.get<{ account_id: string }>(
        'SELECT account_id FROM members WHERE id = ?',
        [bob.id],
      );
      expect(row!.account_id).toBe('acct_bob');
    });

    it('refuses with no valid mscr_ at start', async () => {
      expect((await startLink()).status).toBe(401);
      expect((await startLink('mscr_bogus')).status).toBe(401);
    });

    it('refuses when the pinned member left between start and callback', async () => {
      const state = cookieValue(await startLink(bobCred), SIGNIN_COOKIE)!;
      await seed.run('UPDATE members SET left_at = ? WHERE id = ?', [Date.now(), bob.id]);
      expect((await postCallback({ state, statement: statement('acct_bob') })).status).toBe(403);
      expect(await refusals()).toContain('member_left');
    });

    it('refuses an account already bound to another member, and a member already bound elsewhere', async () => {
      const s1 = cookieValue(await startLink(bobCred), SIGNIN_COOKIE)!;
      expect((await postCallback({ state: s1, statement: statement('acct_ada') })).status).toBe(
        403,
      );
      await bindMemberAccount(seed, bob.id, 'acct_bob');
      const s2 = cookieValue(await startLink(bobCred), SIGNIN_COOKIE)!;
      expect((await postCallback({ state: s2, statement: statement('acct_other') })).status).toBe(
        403,
      );
      expect((await refusals()).filter((r) => r === 'already_bound')).toHaveLength(2);
      expect(await sessionRows()).toBe(0);
    });
  });

  it('invite (§2, ADR 450): a stranger joins under the name chosen at start, bound to their account', async () => {
    const m = await mintInvite(seed, { teamId: team.id, createdBy: 'ada', ceiling: null });
    const state = await startSignin(
      `/live/signin/start?invite=${encodeURIComponent(m.link_secret)}&name=newbie`,
    );
    const r = await postCallback({ state, statement: statement('acct_new') });
    expect(r.status).toBe(303);
    const row = await seed.get<{ account_id: string; kind: string }>(
      "SELECT account_id, kind FROM members WHERE team_id = ? AND name = 'newbie'",
      [team.id],
    );
    expect(row).toEqual({ account_id: 'acct_new', kind: 'human' });
    // A bad invite at start is refused before any console round trip.
    expect((await call('GET', '/live/signin/start?invite=XXX.nope&name=x')).status).toBe(403);
    expect(
      (await call('GET', `/live/signin/start?invite=${encodeURIComponent(m.link_secret)}&name=ada`))
        .status,
    ).toBe(409);
  });

  describe('the session buys one route (§3)', () => {
    it('trades the cookie for a 15-minute msat_ that works as a bearer', async () => {
      const cookie = await signIn();
      const r = await exchange(cookie);
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body) as { as: string; access_token: string; expires_in: number };
      expect(body.as).toBe('ada');
      expect(body.access_token.startsWith('msat_')).toBe(true);
      expect(body.expires_in).toBe(900);
      expect(r.body).not.toContain('refresh');
      const members = await call('GET', '/teams/revive/members', {
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(members.status).toBe(200);
    });

    it('refuses no cookie, a foreign Origin, a cross-site fetch, a revoked or idle or expired session', async () => {
      const cookie = await signIn();
      expect((await exchange(null)).status).toBe(401);
      expect((await exchange(cookie, { origin: 'https://evil.test' })).status).toBe(401);
      expect((await exchange(cookie, { 'sec-fetch-site': 'cross-site' })).status).toBe(401);
      await seed.run('UPDATE browser_sessions SET last_used_at = 1');
      expect((await exchange(cookie)).status).toBe(401);
      await seed.run('UPDATE browser_sessions SET last_used_at = ?, expires_at = 1', [Date.now()]);
      expect((await exchange(cookie)).status).toBe(401);
      await seed.run('UPDATE browser_sessions SET expires_at = ?, revoked_at = 1', [
        Date.now() + 1e9,
      ]);
      expect((await exchange(cookie)).status).toBe(401);
      expect(await refusals()).toEqual(
        expect.arrayContaining([
          'no_cookie',
          'origin',
          'not_same_origin',
          'session_idle',
          'session_expired',
          'session_revoked',
        ]),
      );
    });

    it('the cookie sent as a bearer is refused on any other route', async () => {
      const cookie = await signIn();
      const r = await call('GET', '/teams/revive/members', {
        headers: { authorization: `Bearer ${cookie}` },
      });
      expect(r.status).toBe(401);
    });
  });

  describe('revocation (§4)', () => {
    async function openSocket(
      accessToken: string,
    ): Promise<{ ws: WebSocket; closed: Promise<number> }> {
      const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { headers: { host: HOST } });
      await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
      const occupied = new Promise<{ type: string }>((r) =>
        ws.on('message', (d) => {
          const f = JSON.parse(String(d)) as { type: string };
          if (f.type === 'occupied' || f.type === 'refused' || f.type === 'error') r(f);
        }),
      );
      const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
      ws.send(
        JSON.stringify({
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: 'revive',
          key: accessToken,
          target: { seat: 'ada' },
          surface: 'web',
        }),
      );
      expect((await occupied).type).toBe('occupied');
      return { ws, closed };
    }
    const tokenFor = async (cookie: string) =>
      (JSON.parse((await exchange(cookie)).body) as { access_token: string }).access_token;
    const listSessions = async (bearer: string, who = 'ada') =>
      call('GET', `/teams/revive/members/${who}/sessions`, {
        headers: { authorization: `Bearer ${bearer}` },
      });

    it('a member lists their sessions; revoking one refuses its next exchange and closes its socket', async () => {
      const cookie = await signIn();
      const token = await tokenFor(cookie);
      const { closed } = await openSocket(token);
      const list = await listSessions(adaCred);
      expect(list.status).toBe(200);
      const sessions = (JSON.parse(list.body) as { sessions: { id: string; label: string }[] })
        .sessions;
      expect(sessions).toHaveLength(1);
      expect(list.body).not.toContain('secret');
      const del = await call('DELETE', `/teams/revive/members/ada/sessions/${sessions[0]!.id}`, {
        headers: { authorization: `Bearer ${adaCred}` },
      });
      expect(del.status).toBe(204);
      expect(await closed).toBe(SIGNED_OUT_CLOSE_CODE);
      expect((await exchange(cookie)).status).toBe(401);
      // The access token minted on that session is dead too.
      expect((await listSessions(token)).status).toBe(401);
    });

    it('signout revokes the session from its own page and clears the cookie', async () => {
      const cookie = await signIn();
      const r = await call('POST', '/live/signout', {
        headers: {
          origin: TEAM_ORIGIN,
          'sec-fetch-site': 'same-origin',
          cookie: `${SESSION_COOKIE}=${cookie}`,
        },
      });
      expect(r.status).toBe(204);
      expect(cookies(r).find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toContain('Max-Age=0');
      expect((await exchange(cookie)).status).toBe(401);
    });

    async function makeAdmin(name: string): Promise<string> {
      const row = (await addMember(seed, team, { name, kind: 'human', role: '' })).row;
      await setMemberGovernance(
        seed,
        row.id,
        null,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      );
      return (await mintCredential(seed, row.id)).credential;
    }

    it('another member sees nothing of ada’s sessions; an admin sees and ends them', async () => {
      const cookie = await signIn();
      const bob = (await addMember(seed, team, { name: 'bob', kind: 'human', role: '' })).row;
      const bobCred = (await mintCredential(seed, bob.id)).credential;
      expect((await listSessions(bobCred)).status).toBe(404);
      const adminCred = await makeAdmin('nick');
      const list = await listSessions(adminCred);
      expect(list.status).toBe(200);
      const id = (JSON.parse(list.body) as { sessions: { id: string }[] }).sessions[0]!.id;
      // bob cannot end it; the admin can, and the row says it was an admin.
      expect(
        (
          await call('DELETE', `/teams/revive/members/ada/sessions/${id}`, {
            headers: { authorization: `Bearer ${bobCred}` },
          })
        ).status,
      ).toBe(404);
      const del = await call('DELETE', `/teams/revive/members/ada/sessions/${id}`, {
        headers: { authorization: `Bearer ${adminCred}` },
      });
      expect(del.status).toBe(204);
      expect((await exchange(cookie)).status).toBe(401);
      const row = (await listAudit(seed, team.id)).find((a) => a.action === 'session.revoked')!;
      expect([row.actor, row.target, JSON.parse(String(row.detail)).by]).toEqual([
        'nick',
        'ada',
        'admin',
      ]);
    });

    it('credential rotate revokes every browser session of that member', async () => {
      const one = await signIn();
      const two = await signIn();
      const adminCred = await makeAdmin('nick');
      const rot = await call('POST', '/teams/revive/members/ada/credential/rotate', {
        headers: { authorization: `Bearer ${adminCred}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(rot.status).toBe(200);
      expect((await exchange(one)).status).toBe(401);
      expect((await exchange(two)).status).toBe(401);
      const revoked = (await listAudit(seed, team.id)).filter(
        (a) => a.action === 'session.revoked',
      );
      expect(revoked.map((a) => JSON.parse(String(a.detail)).by)).toEqual(['rotate', 'rotate']);
    });
  });
});

describe('self-hosted (ADR 722 §5): untouched', () => {
  it('answers 404 on all four routes', async () => {
    const db = await openTestDriver('sqlite');
    const s = createServer({ db, port: 0 });
    const { port } = await s.listen();
    try {
      for (const [method, path] of [
        ['GET', '/live/signin/start'],
        ['POST', '/live/signin/callback'],
        ['POST', '/live/session/token'],
        ['POST', '/live/signout'],
      ] as const) {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { method });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
    } finally {
      await s.close();
    }
  });
});
