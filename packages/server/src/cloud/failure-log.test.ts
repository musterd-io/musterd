import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTestDriver, testCloudPools } from '../db/testing.js';
import { createServer } from '../index.js';
import { log, type LogFields } from '../log.js';
import { addMember, mintCredential } from '../store/members.js';
import { mintTokenPair, registerClient } from '../store/oauth.js';
import { createTeam } from '../store/teams.js';
import { resetMcpHandlersForTest } from '../transport/mcpHttp.js';
import { hostRequest, stubCloudEnv } from './testing.js';

/**
 * A 500 says why on its own request log line (lane 01M3ZPM3FE). Cloud load run 3 (2026-10-03)
 * answered 261 requests with a 500 and the logs held nothing but `status: 500` — the error that
 * caused each one went to the client and nowhere else. The line now carries the error's class, its
 * Postgres SQLSTATE when there is one, and a bounded message with credential-shaped text redacted.
 */

/** A cloud server whose next statement matching `match` fails with `error`, once `arm()` is called. */
async function bootCloudWithQueryFault(fault: { match: RegExp; error: Error }) {
  stubCloudEnv();
  const seed = await openTestDriver('pglite');
  await openTestDriver('pglite', { store: 'trace' });
  const pools = (await testCloudPools()).factories;
  let armed = false;
  const main = (u: string) => {
    const p = pools.main(u);
    return {
      connect: async () => {
        const c = await p.connect();
        return new Proxy(c, {
          get(target, key) {
            const v: unknown = Reflect.get(target, key, target);
            if (typeof v !== 'function') return v;
            if (key !== 'query') return v.bind(target);
            return (text: unknown, params?: unknown) => {
              if (armed && typeof text === 'string' && fault.match.test(text)) {
                armed = false;
                return Promise.reject(fault.error);
              }
              return v.call(target, text, params);
            };
          },
        });
      },
      end: () => p.end(),
    };
  };
  const s = createServer({ cloudPools: { ...pools, main }, rosterRoots: [], port: 0 });
  await s.listen();
  return { s, seed, url: `http://127.0.0.1:${s.port}`, arm: () => void (armed = true) };
}

describe('a 500 carries its cause on the request log line (lane 01M3ZPM3FE)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('class, SQLSTATE and a bounded message, with a credential in the message redacted', async () => {
    const errorLog = vi.spyOn(log, 'error');
    const leaked = `mscr_${'Q'.repeat(40)}`;
    const statement = `SELECT * FROM private_schema.members WHERE token = '${leaked}'`;
    const deadlock = Object.assign(
      new Error(`deadlock detected while holding "${leaked}"\n  in: ${statement}`),
      { code: '40P01' },
    );
    const { s, seed, url, arm } = await bootCloudWithQueryFault({
      match: /from members/i,
      error: deadlock,
    });
    try {
      const team = await createTeam(seed, { slug: 'revive' });
      const { row } = await addMember(seed, team, { name: 'ada', kind: 'human', role: '' });
      const token = (await mintCredential(seed, row.id)).credential;
      arm();
      const r = await hostRequest(url, '/teams/revive/members', 'revive.musterd.test', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.status, r.body).toBe(500);
      expect(JSON.parse(r.body)).toEqual({
        error: { code: 'server_error', message: 'internal server error' },
      });
      expect(r.body).not.toContain('in:');
      expect(r.body).not.toContain(statement);
      const line = await vi.waitFor(() => {
        const found = errorLog.mock.calls
          .map(([fields]) => fields)
          .find((f: LogFields) => f.msg === 'http_request' && f.status === 500);
        expect(found).toBeDefined();
        return found!;
      });
      expect(line).toMatchObject({ err_class: 'Error', sqlstate: '40P01' });
      const err = String(line.err);
      expect(err).toContain('deadlock detected');
      expect(err).toContain('in: SELECT * FROM private_schema.members');
      expect(err).not.toContain(leaked);
      expect(err).toContain('[redacted]');
      expect(err.length).toBeLessThanOrEqual(300);
    } finally {
      await s.close();
    }
  });

  it('keeps the raw query off a remote-MCP result and on its request log line', async () => {
    resetMcpHandlersForTest();
    const errorLog = vi.spyOn(log, 'error');
    const statement = 'SELECT * FROM private_schema.messages WHERE team_id = ?';
    const queryError = Object.assign(new Error(`relation lookup failed\n  in: ${statement}`), {
      code: '42P01',
    });
    const { s, seed, url, arm } = await bootCloudWithQueryFault({
      match: /from messages/i,
      error: queryError,
    });
    try {
      const team = await createTeam(seed, { slug: 'revive' });
      const { row } = await addMember(seed, team, {
        name: 'ada',
        kind: 'human',
        role: '',
      });
      const { client_id } = await registerClient(seed, {
        teamId: team.id,
        clientName: 'error-sanitization-test',
        redirectUris: ['https://app.example/cb'],
      });
      const pair = await mintTokenPair(seed, {
        teamId: team.id,
        memberId: row.id,
        clientId: client_id,
      });
      const call = (id: number, method: string, params: unknown) =>
        hostRequest(url, '/mcp/revive', 'revive.musterd.test', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${pair.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-forwarded-proto': 'https',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        });

      const initialized = await call(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'error-test', version: '0' },
      });
      expect(initialized.status, initialized.body).toBe(200);

      arm();
      const r = await call(2, 'tools/call', {
        name: 'team_inbox_check',
        arguments: {},
      });
      expect(r.status, r.body).toBe(200); // Streamable HTTP returns tool failures in the MCP result.
      expect(r.body).toContain('internal server error');
      expect(r.body).not.toContain('in:');
      expect(r.body).not.toContain(statement);

      const line = await vi.waitFor(() => {
        const found = errorLog.mock.calls
          .map(([fields]) => fields)
          .find(
            (f: LogFields) =>
              f.msg === 'http_request' && f.path === '/mcp/[redacted]' && f.status === 200,
          );
        expect(found).toBeDefined();
        return found!;
      });
      expect(line).toMatchObject({ err_class: 'Error', sqlstate: '42P01' });
      expect(String(line.err)).toContain('in: SELECT * FROM private_schema.messages');
    } finally {
      resetMcpHandlersForTest();
      await s.close();
    }
  });

  it('sanitizes an OAuth authorization error and logs its cause on the request line', async () => {
    const errorLog = vi.spyOn(log, 'error');
    const statement = 'SELECT * FROM private_schema.oauth_clients WHERE client_id = ?';
    const queryError = Object.assign(new Error(`relation lookup failed\n  in: ${statement}`), {
      code: '42P01',
    });
    const { s, seed, url, arm } = await bootCloudWithQueryFault({
      match: /oauth_clients/i,
      error: queryError,
    });
    try {
      const team = await createTeam(seed, { slug: 'revive' });
      const { client_id } = await registerClient(seed, {
        teamId: team.id,
        clientName: 'oauth-error-test',
        redirectUris: ['https://app.example/cb'],
      });
      const query = new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri: 'https://app.example/cb',
        state: 'state',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      });

      arm();
      const r = await hostRequest(url, `/oauth/revive/authorize?${query}`, 'revive.musterd.test', {
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(r.status, r.body).toBe(500);
      expect(JSON.parse(r.body)).toEqual({
        error: { code: 'server_error', message: 'internal server error' },
      });
      expect(r.body).not.toContain('in:');
      expect(r.body).not.toContain(statement);

      const line = await vi.waitFor(() => {
        const found = errorLog.mock.calls
          .map(([fields]) => fields)
          .find((f: LogFields) => f.msg === 'http_request' && f.status === 500);
        expect(found).toBeDefined();
        return found!;
      });
      expect(line).toMatchObject({ sqlstate: '42P01' });
      expect(String(line.err)).toContain('in: SELECT * FROM private_schema.oauth_clients');
    } finally {
      await s.close();
    }
  });

  it('sanitizes unexpected OAuth token failures and logs their cause', async () => {
    const errorLog = vi.spyOn(log, 'error');
    const statement = 'SELECT * FROM private_schema.oauth_codes WHERE code_hash = ?';
    const queryError = Object.assign(new Error(`relation lookup failed\n  in: ${statement}`), {
      code: '42P01',
    });
    const { s, seed, url, arm } = await bootCloudWithQueryFault({
      match: /oauth_codes/i,
      error: queryError,
    });
    try {
      const team = await createTeam(seed, { slug: 'revive' });
      const { client_id } = await registerClient(seed, {
        teamId: team.id,
        clientName: 'oauth-token-error-test',
        redirectUris: ['https://app.example/cb'],
      });

      arm();
      const r = await hostRequest(url, '/oauth/revive/token', 'revive.musterd.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'mscode_missing',
          redirect_uri: 'https://app.example/cb',
          client_id,
          code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        }),
      });
      expect(r.status, r.body).toBe(400);
      expect(JSON.parse(r.body)).toEqual({
        error: 'invalid_grant',
        error_description: 'internal server error',
      });
      expect(r.body).not.toContain('in:');
      expect(r.body).not.toContain(statement);

      const line = await vi.waitFor(() => {
        const found = errorLog.mock.calls
          .map(([fields]) => fields)
          .find((f: LogFields) => f.msg === 'http_request' && f.status === 400);
        expect(found).toBeDefined();
        return found!;
      });
      expect(line).toMatchObject({ sqlstate: '42P01' });
      expect(String(line.err)).toContain('in: SELECT * FROM private_schema.oauth_codes');
    } finally {
      await s.close();
    }
  });

  it('sanitizes unexpected OAuth refresh failures and logs their cause', async () => {
    const errorLog = vi.spyOn(log, 'error');
    const statement = 'SELECT * FROM private_schema.oauth_tokens WHERE token_hash = ?';
    const queryError = Object.assign(new Error(`relation lookup failed\n  in: ${statement}`), {
      code: '42P01',
    });
    const { s, seed, url, arm } = await bootCloudWithQueryFault({
      match: /oauth_tokens/i,
      error: queryError,
    });
    try {
      const team = await createTeam(seed, { slug: 'revive' });
      const { row } = await addMember(seed, team, { name: 'ada', kind: 'human', role: '' });
      const { client_id } = await registerClient(seed, {
        teamId: team.id,
        clientName: 'oauth-refresh-error-test',
        redirectUris: ['https://app.example/cb'],
      });
      const pair = await mintTokenPair(seed, {
        teamId: team.id,
        memberId: row.id,
        clientId: client_id,
      });

      arm();
      const r = await hostRequest(url, '/oauth/revive/token', 'revive.musterd.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: pair.refresh_token,
          client_id,
        }),
      });
      expect(r.status, r.body).toBe(400);
      expect(JSON.parse(r.body)).toEqual({
        error: 'invalid_grant',
        error_description: 'internal server error',
      });
      expect(r.body).not.toContain('in:');
      expect(r.body).not.toContain(statement);

      const line = await vi.waitFor(() => {
        const found = errorLog.mock.calls
          .map(([fields]) => fields)
          .find((f: LogFields) => f.msg === 'http_request' && f.status === 400);
        expect(found).toBeDefined();
        return found!;
      });
      expect(line).toMatchObject({ sqlstate: '42P01' });
      expect(String(line.err)).toContain('in: SELECT * FROM private_schema.oauth_tokens');
    } finally {
      await s.close();
    }
  });
});
