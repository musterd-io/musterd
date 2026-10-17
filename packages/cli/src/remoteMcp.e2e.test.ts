import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TALK_ONLY_TOOLS } from '@musterd/mcp';
import { PROTOCOL_VERSION } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteMcp } from './commands/serve.js';

/**
 * The remote MCP as `musterd serve` composes it (ADR 630): a real daemon, the adapter's own tools
 * built per request by `remoteMcp`, and a phone that is nothing but an `msat_` bearer minted by
 * the daemon's OAuth routes. This package depends on both the server and the adapter, so it is
 * the one place the whole loop can run (ADR 630 §8).
 */

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'https://app.example/cb';

let server: RunningServer;
let base: string;
let nickCred: string;
let dir: string;

async function json(method: string, path: string, body?: unknown, token?: string) {
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

/** The connector's sign-in: register, authorize with a credential or an invite, exchange. */
async function phoneBearer(proof: Record<string, string>): Promise<string> {
  const reg = await json('POST', '/oauth/dawn/register', {
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
    ...proof,
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
  return ((await token.json()) as { access_token: string }).access_token;
}

/** One MCP frame over Streamable HTTP, through node:http so a test can set the phone's Host. */
function frame(
  bearer: string,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const url = new URL(base + '/mcp/dawn');
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${bearer}`,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const data = text.includes('data:')
            ? text
                .split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trim())
                .join('\n')
            : text;
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function tool(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const r = await frame(bearer, 'tools/call', { name, arguments: args });
  return {
    text: ((r.body?.result?.content ?? []) as { text?: string }[]).map((c) => c.text).join('\n'),
    body: r.body,
  };
}

async function toolNames(bearer: string): Promise<string[]> {
  const r = await frame(bearer, 'tools/list', {});
  return (r.body.result.tools as { name: string }[]).map((t) => t.name);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-remote-mcp-'));
  // The invite HMAC key is generated beside the effective config; keep it out of ~/.musterd.
  vi.stubEnv('MUSTERD_CONFIG', join(dir, 'config.json'));
  // A public face the phone arrives on, as a tunnel's hostname would be (ADR 446).
  vi.stubEnv('MUSTERD_ALLOWED_HOSTS', 'phone.example');
  server = createServer({ db: openDb(':memory:'), port: 0, rosterRoots: [], remoteMcp });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await json('POST', '/teams', {
    slug: 'dawn',
    creator: { name: 'nick', kind: 'human' },
  });
  nickCred = team.json.human_credential;
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('the remote MCP serves the adapter’s tools (ADR 630)', () => {
  it('a member’s phone claims and submits a lane, and its inbox cursor advances', async () => {
    const phone = await phoneBearer({ member: 'nick', credential: nickCred });
    const names = await toolNames(phone);
    expect(names).toContain('lane_claim');
    expect(names).toContain('team_agent_create');

    expect((await tool(phone, 'team_join')).text).toMatch(/as nick through a remote connector/);

    const bo = await json('POST', '/teams/dawn/members', { name: 'Bo', kind: 'human' }, nickCred);
    const sent = await json(
      'POST',
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'm-bo-1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Bo',
          to: { kind: 'team' },
          act: 'message',
          body: 'hello-from-bo',
          ts: Date.now(),
        },
      },
      bo.json.human_credential,
    );
    expect(sent.status).toBeLessThan(300);
    expect((await tool(phone, 'team_inbox_check')).text).toContain('hello-from-bo');
    // The daemon's own copy never moved the cursor, so this came back again (ADR 630 Context).
    expect((await tool(phone, 'team_inbox_check')).text).not.toContain('hello-from-bo');

    const opened = await tool(phone, 'lane_open', { title: 'phone lane' });
    const id = /\b(01[0-9A-HJKMNP-TV-Z]{24})\b/.exec(opened.text)?.[1];
    expect(id, opened.text).toBeDefined();
    expect((await tool(phone, 'lane_claim', { id })).text).toContain('owner=nick');
    expect((await tool(phone, 'lane_update', { id, state: 'awaiting_acceptance' })).text).toContain(
      'awaiting_acceptance',
    );

    // Counted on the remote rail (ADR 640), flushed as each call finished.
    await vi.waitFor(async () => {
      const rails = await server.store.all<{ rail: string; calls: number }>(
        "SELECT rail, SUM(calls) AS calls FROM tool_call_stats WHERE tool = 'team_inbox_check' GROUP BY rail",
      );
      expect(rails).toEqual([{ rail: 'remote', calls: 2 }]);
    });
  });

  it('a guest admitted by a default invite sees only talk tools and cannot call lane_claim', async () => {
    const invite = await json('POST', '/teams/dawn/invites', {}, nickCred);
    expect(invite.status).toBe(201);
    const guest = await phoneBearer({ invite: invite.json.room_code, member: 'gia' });
    const names = await toolNames(guest);
    expect(names).toContain('team_send');
    for (const name of names) expect(TALK_ONLY_TOOLS.has(name), name).toBe(true);
    const refused = await frame(guest, 'tools/call', {
      name: 'lane_claim',
      arguments: { id: 'x' },
    });
    expect(JSON.stringify(refused.body)).toMatch(/not found|talk-only/i);
    expect(
      (await tool(guest, 'team_send', { act: 'message', body: 'hi from the room' })).text,
    ).not.toMatch(/^error/);
  });

  it('team_agent_create mints a sponsored agent with a link on the host the phone used', async () => {
    const phone = await phoneBearer({ member: 'nick', credential: nickCred });
    const r = await frame(
      phone,
      'tools/call',
      { name: 'team_agent_create', arguments: { name: 'nick-scout', role: 'research' } },
      { host: 'phone.example', 'x-forwarded-proto': 'https' },
    );
    const text: string = r.body.result.content[0].text;
    expect(text).toContain('Created agent "nick-scout"');
    expect(text).toContain('The team has been told');
    // The link names the phone's public host, not the loopback address the tool called.
    expect(text).toMatch(/https:\/\/phone\.example\/join\/dawn#n=[A-Za-z0-9_-]{43}/);
    expect(text).not.toMatch(/ms(cr|ac|at|kd)_/);
    expect((await tool(phone, 'team_agent_create', { name: 'nick-scout' })).text).toContain(
      'already exists',
    );
  });

  it('team_agent_connect follows the team’s agent_connect policy', async () => {
    const minted = await json(
      'POST',
      '/teams/dawn/members/agents',
      { name: 'nick-scout' },
      nickCred,
    );
    expect(minted.status).toBe(201);
    const dana = await json(
      'POST',
      '/teams/dawn/members',
      { name: 'dana', kind: 'human' },
      nickCred,
    );
    const phone = await phoneBearer({ member: 'dana', credential: dana.json.human_credential });
    expect((await tool(phone, 'team_agent_connect', { name: 'nick-scout' })).text).toMatch(
      /sponsor or an admin/,
    );
    const policy = await json(
      'POST',
      '/teams/dawn/policy',
      { agent_connect: 'any_member', invite_requires_expiry: true },
      nickCred,
    );
    expect(policy.status).toBe(200);
    expect((await tool(phone, 'team_agent_connect', { name: 'nick-scout' })).text).toMatch(
      /\/join\/dawn#n=[A-Za-z0-9_-]{43}/,
    );
  });
});
