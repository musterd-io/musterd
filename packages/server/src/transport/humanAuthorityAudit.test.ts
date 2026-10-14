import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const http = readFileSync(fileURLToPath(new URL('./http.ts', import.meta.url)), 'utf8');
const oauth = readFileSync(fileURLToPath(new URL('./oauth.ts', import.meta.url)), 'utf8');

function routeBlock(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`route audit anchor missing: ${start}`);
  return source.slice(from, to);
}

const routes = [
  {
    name: 'POST /teams bootstrap',
    source: http,
    start: "if (method === 'POST' && path === '/teams') {",
    end: "if (method === 'POST' && path === '/agent-bootstrap-migrations') {",
    gates: [/createTeam\(ctx\.db/, /setMemberGovernance\(/, /await mintCredential\(ctx\.db/],
  },
  {
    name: 'POST /teams/:slug/members',
    source: http,
    start: "if (method === 'POST' && rest === '/members') {",
    end: "if (method === 'POST' && rest === '/members/agents') {",
    gates: [
      /body\.observer === true \|\|/,
      /targetKind === 'human'/,
      /await authProvision\(ctx, slug, req,\s*\{/,
      /rosterProjectionRequiresHumanAdmin\(ctx, provisioningTeam, spec\)/,
      /await mintCredential\(ctx\.db/,
    ],
  },
  {
    name: 'POST /teams/:slug/members/:name/credential/rotate',
    source: http,
    start: 'const credentialRotateMatch = rest.match(',
    end: '// ── Halt as revocation',
    gates: [/await authAdmin\(ctx, slug, req\)/, /await mintCredential\(ctx\.db/],
  },
  {
    name: 'GET /teams/:slug/local-identity',
    source: http,
    start: "if (method === 'GET' && rest === '/local-identity') {",
    end: 'const handoffMatch = rest.match(',
    gates: [
      /requireLocalPeer\(/,
      /await authHuman\(ctx, slug, req\)/,
      /const credential = bearer\(req\)/,
    ],
  },
  {
    name: 'POST /teams/:slug/signin-handoff',
    source: http,
    start: "if (method === 'POST' && rest === '/signin-handoff') {",
    end: '/**\n       * `GET /teams/:slug/local-identity`',
    gates: [
      /requireLocalPeer\(ctx, req, 'stage a sign-in handoff'\)/,
      /await authHuman\(ctx, slug, req\)/,
      /member\.name !== body\.member \|\| bearer\(req\) !== body\.credential/,
    ],
  },
  {
    name: 'GET /teams/:slug/signin-handoff/:nonce',
    source: http,
    start: "if (method === 'GET' && handoffMatch) {",
    end: '// The governance audit log (ADR 071, P2)',
    gates: [/requireLocalPeer\(/, /redeemHandoff\(/],
  },
  {
    name: 'POST /teams/:slug/invites',
    source: http,
    start: "if (method === 'POST' && rest === '/invites') {",
    end: "if (method === 'GET' && rest === '/invites') {",
    gates: [/await authAdmin\(ctx, slug, req\)/, /mintTeamInvite\(/],
  },
  {
    name: 'POST /oauth/:team/authorize',
    source: oauth,
    start: "if (method === 'POST' && rest === '/authorize') {",
    end: "if (method === 'POST' && rest === '/token') {",
    gates: [
      /requireTlsPeer\(ctx, req, 'authorization'\)/,
      /body\.proof\.kind === 'invite'/,
      /checkInvite\(/,
    ],
  },
  {
    name: 'POST /oauth/:team/token',
    source: oauth,
    start: "if (method === 'POST' && rest === '/token') {",
    end: "if (rest === '/revoke') {",
    gates: [/requireTlsPeer\(ctx, req, 'token issuance'\)/, /redeemCode\(/, /mintTokenPair\(/],
  },
  {
    name: 'GET and DELETE /teams/:slug/grants',
    source: http,
    start: "if (method === 'GET' && rest === '/grants') {",
    end: '// Soft-archive the team',
    gates: [/await authAdmin\(ctx, slug, req\)/, /listGrants\(/, /revokeGrant\(/],
  },
];

describe('human credential and admin route audit (ADR 580)', () => {
  it.each(routes)('$name records its authority gate', (route) => {
    const block = routeBlock(route.source, route.start, route.end);
    for (const gate of route.gates) expect(block).toMatch(gate);
  });

  it('enumerates every direct human credential mint and admin confer site', () => {
    expect(http.match(/await mintCredential\(ctx\.db,/g)).toHaveLength(4);
    expect(http.match(/await setMemberGovernance\(/g)).toHaveLength(1);
  });

  it('defines admin as a human member and preflights human/admin roster changes', () => {
    expect(http).toMatch(/async function authHuman\(/);
    expect(http).toMatch(/auth\.member\.kind !== 'human'/);
    expect(http).toMatch(/async function authAdmin\(/);
    expect(http).toMatch(/!resolveCapabilities\(auth\.member\)\.is_admin/);
    expect(http).toMatch(/async function rosterProjectionRequiresHumanAdmin\(/);
    expect(http).toMatch(/seatRoles\(seat\)/);
    expect(http).toMatch(/effectiveCapabilities\(roleDefaults, seat\.capabilities \?\? \{\}\)/);
    expect(http).toMatch(/nextIsAdmin !== resolveCapabilities\(current\)\.is_admin/);
    expect(http).toMatch(/!projectedHumanAdmins\.has\(current\.name\)/);
  });
});
