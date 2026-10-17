import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriverError, POOL_EXHAUSTED_SENTENCE, type Driver } from '../db/driver.js';
import { PG_POOL_ACQUIRE_TIMEOUT } from '../db/pgDriver.js';
import { addMember, mintCredential } from '../store/members.js';
import { mintTokenPair, registerClient } from '../store/oauth.js';
import type { TeamRow } from '../store/rows.js';
import { createTeam, requireTeam } from '../store/teams.js';
import { resetMcpHandlersForTest } from '../transport/mcpHttp.js';
import { bootCloudWithOutage, hostRequest } from './testing.js';

// The remote-MCP factory's team read, failable on its own (the route's reads stay real).
vi.mock('../store/teams.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/teams.js')>();
  return { ...actual, requireTeam: vi.fn(actual.requireTeam) };
});

/**
 * Lane 01M3ZC3G35. The 2026-10-02 load test answered 3,565 requests 503 "database unreachable:
 * timeout exceeded when trying to connect" while Neon served throughout — the pool's acquire timed
 * out because the app was starved — and 34 `/mcp` calls a bare 500 for the same cause. A full pool
 * is now its own stable sentence, and `/mcp` answers it (and an outage) 503 as REST does.
 */

const exhaustedBody = { error: { code: 'server_error', message: POOL_EXHAUSTED_SENTENCE } };

async function humanCredential(db: Driver, team: TeamRow, name: string): Promise<string> {
  const { row } = await addMember(db, team, { name, kind: 'human', role: '' });
  return (await mintCredential(db, row.id)).credential;
}

async function oauthBearer(db: Driver, team: TeamRow): Promise<string> {
  const { row } = await addMember(db, team, { name: 'ada', kind: 'human', role: '' });
  const { client_id } = await registerClient(db, {
    teamId: team.id,
    clientName: 'pool-exhausted-test',
    redirectUris: ['https://app.example/cb'],
  });
  const pair = await mintTokenPair(db, { teamId: team.id, memberId: row.id, clientId: client_id });
  return pair.access_token;
}

function mcpInitialize(url: string, bearer: string) {
  return hostRequest(url, '/mcp/revive', 'revive.musterd.test', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-proto': 'https',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pool-exhausted-test', version: '0' },
      },
    }),
  });
}

describe('a full pool is not an outage (lane 01M3ZC3G35)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(requireTeam).mockReset();
    resetMcpHandlersForTest();
  });

  it('/health says "database pool exhausted", not "database unreachable"; recovery is automatic', async () => {
    const { s, url, setExhausted } = await bootCloudWithOutage();
    try {
      setExhausted(true);
      const full = await fetch(url + '/health');
      expect(full.status).toBe(503);
      expect(await full.json()).toEqual({ ok: false, reason: POOL_EXHAUSTED_SENTENCE });
      setExhausted(false);
      const up = await fetch(url + '/health');
      expect(up.status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('a team route answers a full pool 503 with its own sentence', async () => {
    const { s, seed, url, setExhausted } = await bootCloudWithOutage();
    try {
      const revive = await createTeam(seed, { slug: 'revive' });
      const token = await humanCredential(seed, revive, 'ada');
      setExhausted(true);
      const r = await hostRequest(url, '/teams/revive/members', 'revive.musterd.test', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.status, r.body).toBe(503);
      expect(JSON.parse(r.body)).toEqual(exhaustedBody);
    } finally {
      setExhausted(false);
      await s.close();
    }
  });

  it('/mcp answers a full pool 503 with the same sentence, and an outage 503 "database unreachable"', async () => {
    resetMcpHandlersForTest();
    const { s, seed, url, setExhausted, setDown } = await bootCloudWithOutage();
    try {
      const revive = await createTeam(seed, { slug: 'revive' });
      const bearer = await oauthBearer(seed, revive);
      setExhausted(true);
      const full = await mcpInitialize(url, bearer);
      expect(full.status, full.body).toBe(503);
      expect(JSON.parse(full.body)).toEqual(exhaustedBody);
      setExhausted(false);
      setDown(true);
      const out = await mcpInitialize(url, bearer);
      expect(out.status, out.body).toBe(503);
      expect(JSON.parse(out.body)).toEqual({
        error: { code: 'server_error', message: 'database unreachable' },
      });
    } finally {
      setExhausted(false);
      setDown(false);
      await s.close();
    }
  });

  it("/mcp answers a store failure inside the SDK's per-request factory 503, not the SDK's bare 500", async () => {
    resetMcpHandlersForTest();
    // ADR 630: the factory is the embedder's (`musterd serve` composes the adapter); here it is a
    // stub whose store read fails, as the adapter's would on a saturated pool. The route's own team
    // and auth reads run as normal.
    const { s, seed, url } = await bootCloudWithOutage({
      remoteMcp: () => {
        throw new DriverError(
          `${POOL_EXHAUSTED_SENTENCE}: ${PG_POOL_ACQUIRE_TIMEOUT}`,
          'saturated',
        );
      },
    });
    try {
      const revive = await createTeam(seed, { slug: 'revive' });
      const bearer = await oauthBearer(seed, revive);
      const r = await mcpInitialize(url, bearer);
      expect(r.status, r.body).toBe(503);
      expect(JSON.parse(r.body)).toEqual(exhaustedBody);
    } finally {
      await s.close();
    }
  });
});
