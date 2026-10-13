import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addMember } from '../store/members.js';
import { createTeam } from '../store/teams.js';
import { bootCloud, hostRequest } from './testing.js';

/**
 * Spec §8.3 — the loopback audit test, behavioural half. A cloud server, a caller on 127.0.0.1
 * with NO credential and plain http, and every path that used to trust that caller: none may
 * answer 2xx. Each row carries the gate it exercises, and the table is checked against the source
 * — a new call site of a former shortcut without a row here fails the suite.
 */
type Gate = 'requireLocalPeer' | 'authProvision' | 'authAdmin' | 'tls' | 'console';
interface Row {
  gate: Gate;
  method: 'GET' | 'POST';
  path: string;
  /** What the gate answers on Cloud. */
  want: number;
}

const ROWS: Row[] = [
  // The machine verbs (Decision 2): not mounted.
  { gate: 'requireLocalPeer', method: 'POST', path: '/store/prune', want: 404 },
  { gate: 'requireLocalPeer', method: 'POST', path: '/store/compact', want: 404 },
  { gate: 'requireLocalPeer', method: 'POST', path: '/node/enroll', want: 404 },
  { gate: 'requireLocalPeer', method: 'POST', path: '/teams/revive/signin-handoff', want: 404 },
  { gate: 'requireLocalPeer', method: 'GET', path: '/teams/revive/local-identity', want: 404 },
  {
    gate: 'requireLocalPeer',
    method: 'GET',
    path: '/teams/revive/signin-handoff/n0nce',
    want: 404,
  },
  // Seat provisioning and credential rotation: an admin credential, never "you are local".
  { gate: 'authProvision', method: 'POST', path: '/teams/revive/members', want: 401 },
  {
    gate: 'authProvision',
    method: 'POST',
    path: '/teams/revive/members/bot/agent-seat-credential/rotate',
    want: 401,
  },
  {
    gate: 'authAdmin',
    method: 'POST',
    path: '/teams/revive/members/ada/credential/rotate',
    want: 401,
  },
  // OAuth + remote MCP: plaintext was fine from loopback; on Cloud only the edge's https counts.
  {
    gate: 'tls',
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/mcp/revive',
    want: 403,
  },
  { gate: 'tls', method: 'GET', path: '/.well-known/oauth-authorization-server/revive', want: 403 },
  { gate: 'tls', method: 'GET', path: '/oauth/revive/.well-known/openid-configuration', want: 403 },
  { gate: 'tls', method: 'POST', path: '/oauth/revive/register', want: 403 },
  { gate: 'tls', method: 'GET', path: '/oauth/revive/authorize', want: 403 },
  { gate: 'tls', method: 'POST', path: '/oauth/revive/authorize', want: 403 },
  { gate: 'tls', method: 'POST', path: '/oauth/revive/token', want: 403 },
  { gate: 'tls', method: 'POST', path: '/oauth/revive/revoke', want: 403 },
  { gate: 'tls', method: 'POST', path: '/mcp/revive', want: 403 },
  // Team creation: a console token (§4.3), which this caller does not have.
  { gate: 'console', method: 'POST', path: '/teams', want: 401 },
];

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../transport/${rel}`, import.meta.url)), 'utf8');
const calls = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe('loopback audit — behavioural (1C task 9, spec §8.3)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('the table covers every call site of every former loopback shortcut', () => {
    const http = src('http.ts');
    const rows = (g: Gate) => ROWS.filter((r) => r.gate === g).length;
    // Call sites, not the definitions (`function requireLocalPeer(`, `function authProvision(`).
    expect(rows('requireLocalPeer')).toBe(calls(http, /(?<!function )requireLocalPeer\(\s*ctx/g));
    expect(rows('authProvision')).toBe(calls(http, /await authProvision\(ctx, slug, req,\s*\{/g));
    expect(rows('tls')).toBe(
      calls(src('oauth.ts'), /requireTlsPeer\(ctx, req,/g) +
        calls(src('mcpHttp.ts'), /isTlsPeer\(ctx, req\)/g),
    );
  });

  it('a credential-less loopback caller over plain http reaches none of them on Cloud', async () => {
    const { s, seed, url } = await bootCloud();
    try {
      const revive = await createTeam(seed!, { slug: 'revive' });
      await addMember(seed!, revive, { name: 'ada', kind: 'human', role: '' });
      await addMember(seed!, revive, { name: 'bot', kind: 'agent', role: '' });
      const got: string[] = [];
      for (const r of ROWS) {
        const res = await hostRequest(url, r.path, 'revive.musterd.test', {
          method: r.method,
          ...(r.method === 'POST'
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(
                  r.path === '/teams/revive/members' ? { name: 'worker', kind: 'human' } : {},
                ),
              }
            : {}),
        });
        got.push(`${r.method} ${r.path} → ${res.status}`);
      }
      expect(got).toEqual(ROWS.map((r) => `${r.method} ${r.path} → ${r.want}`));
    } finally {
      await s.close();
    }
  });
});
