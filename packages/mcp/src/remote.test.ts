import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { GENERALIST_CAPABILITIES, PROTOCOL_VERSION } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TALK_ONLY_TOOLS } from './scope.js';
import { buildRemoteMcpServer, type RemoteSeat } from './index.js';

/**
 * The adapter's remote-bearer mode (ADR 630 §3, §6, §7), against a real daemon with a real `msat_`
 * bearer minted by the daemon's own OAuth routes — the token a phone connector holds.
 *
 * What it pins is the point of the ADR: a phone gets the routes' whole behaviour because its tools
 * ARE the adapter's tools calling those routes. The daemon's own three remote tools never advanced
 * the read cursor; the adapter's inbox check does, so a second unread-only check is empty.
 */

let server: RunningServer;
let base: string;
let nickCred: string;
let boCred: string;

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'https://app.example/cb';

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as any };
}

async function form(path: string, fields: Record<string, string>) {
  return await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

/** The phone's sign-in, as the connector runs it: register, authorize, exchange the code. */
async function phoneBearer(member: string, credential: string): Promise<string> {
  const reg = await api('POST', '/oauth/dawn/register', {
    redirect_uris: [REDIRECT],
    client_name: 'Claude',
  });
  const client_id = reg.json.client_id as string;
  const authz = await form('/oauth/dawn/authorize', {
    client_id,
    redirect_uri: REDIRECT,
    state: 's1',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    member,
    credential,
  });
  expect(authz.status).toBe(302);
  const code = new URL(authz.headers.get('location')!).searchParams.get('code')!;
  const token = await form('/oauth/dawn/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id,
    code_verifier: VERIFIER,
  });
  const pair = (await token.json()) as { access_token: string };
  expect(pair.access_token).toMatch(/^msat_/);
  return pair.access_token;
}

/** A connected MCP client on the remote server for `seat` — what the daemon's handler would serve. */
async function connect(seat: RemoteSeat) {
  const mcp = buildRemoteMcpServer(seat);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const phone = new Client({ name: 'phone', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), phone.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await phone.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
    };
    return r.content.map((c) => c.text ?? '').join('\n');
  };
  return {
    phone,
    call,
    close: async () => {
      await phone.close();
      await mcp.close();
    },
  };
}

async function sendFrom(token: string, from: string, body: string) {
  const envelope = {
    id: `m-${body}`,
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from,
    to: { kind: 'team' as const },
    act: 'message' as const,
    body,
    ts: Date.now(),
  };
  const r = await api('POST', '/teams/dawn/messages', { envelope }, token);
  expect(r.status).toBeLessThan(400);
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await api('POST', '/teams', {
    slug: 'dawn',
    creator: { name: 'nick', kind: 'human', role: 'lead' },
  });
  nickCred = team.json.human_credential;
  const bo = await api('POST', '/teams/dawn/members', { name: 'Bo', kind: 'human' }, nickCred);
  boCred = bo.json.human_credential;
});

afterEach(async () => {
  await server.close();
});

describe('a phone on the remote-bearer adapter (ADR 630)', () => {
  it('advances the read cursor, sends, and claims and submits a lane', async () => {
    const bearer = await phoneBearer('nick', nickCred);
    const s = await connect({ server: base, team: 'dawn', member: 'nick', bearer });
    try {
      expect(await s.call('team_join')).toMatch(/as nick through a remote connector/);

      await sendFrom(boCred, 'Bo', 'hello-from-bo');
      expect(await s.call('team_inbox_check')).toContain('hello-from-bo');
      // The defect the daemon's own copy had: its cursor never moved, so this came back again.
      expect(await s.call('team_inbox_check')).not.toContain('hello-from-bo');
      const unread = await api('GET', '/teams/dawn/inbox?unread=1', undefined, nickCred);
      expect(unread.json.messages).toEqual([]);

      expect(
        await s.call('team_send', { act: 'status_update', body: 'on it from my phone' }),
      ).not.toMatch(/error|refused/i);
      const history = await api('GET', '/teams/dawn/messages?limit=20', undefined, boCred);
      expect(history.json.messages.map((m: { body: string }) => m.body)).toContain(
        'on it from my phone',
      );

      const opened = await s.call('lane_open', { title: 'phone lane' });
      const id = /\b(01[0-9A-HJKMNP-TV-Z]{24})\b/.exec(opened)?.[1];
      expect(id, opened).toBeDefined();
      // No workspace: the lane takes the team default project, not the daemon's repo.
      expect(opened).toContain('project=default');
      expect(await s.call('lane_claim', { id })).toContain('owner=nick');
      expect(await s.call('lane_update', { id, state: 'awaiting_acceptance' })).toContain(
        'awaiting_acceptance',
      );
      const lane = await api('GET', `/teams/dawn/lanes/${id}`, undefined, nickCred);
      expect(lane.json.lane?.state ?? lane.json.state).toBe('awaiting_acceptance');

      // §7: the calls are counted against the seat. The flush is fire-and-forget, so poll briefly.
      let counted = 0;
      for (let i = 0; i < 40 && counted < 2; i++) {
        const report = await api('GET', '/teams/dawn/report', undefined, nickCred);
        const row = (report.json.tool_calls?.tools ?? []).find(
          (t: { tool: string }) => t.tool === 'team_inbox_check',
        );
        counted = row?.calls ?? 0;
        if (counted < 2) await new Promise((r) => setTimeout(r, 50));
      }
      expect(counted).toBe(2);
      // ADR 640: they land on the remote rail, apart from any desk calls the same seat makes.
      const rails = await server.store.all<{ rail: string }>(
        'SELECT DISTINCT rail FROM tool_call_stats',
      );
      expect(rails.map((r) => r.rail)).toEqual(['remote']);
    } finally {
      await s.close();
    }
  }, 60_000);

  it('offers a talk-only seat the talk tools only', async () => {
    const bearer = await phoneBearer('Bo', boCred);
    const s = await connect({
      server: base,
      team: 'dawn',
      member: 'Bo',
      bearer,
      capabilities: { ...GENERALIST_CAPABILITIES, can_coordinate: false },
    });
    try {
      const { tools } = await s.phone.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('team_send');
      expect(names).not.toContain('lane_claim');
      for (const name of names) expect(TALK_ONLY_TOOLS.has(name), name).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('team_leave leaves nothing: the connector sign-in is the seat', async () => {
    const bearer = await phoneBearer('nick', nickCred);
    const s = await connect({ server: base, team: 'dawn', member: 'nick', bearer });
    try {
      expect(await s.call('team_leave')).toMatch(/nothing to leave/);
      // Still the seat afterwards.
      expect(await s.call('team_send', { act: 'message', body: 'still here' })).not.toMatch(
        /haven't joined|not joined/i,
      );
    } finally {
      await s.close();
    }
  });
});
