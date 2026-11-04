import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { openLane } from '../store/lanes.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('gate-shell-writes-http', (_o, kind) => {
  /**
   * ADR 803 over HTTP. §2: one `Bash` call that writes several contended paths is one Gate A request
   * (`also`); the strictest path decides and one `lane.gate` row records it. §3: the after-call check
   * (`after: true`) says `written_unowned` for a changed `block` path no lane of the seat covers, and
   * records it; a covered path is `allowed` with no row.
   */
  let server: RunningServer;
  let base: string;
  let ada: AgentHttpAuth;

  const seat = () => ({
    authorization: `Bearer ${ada.key}`,
    'x-musterd-seat': 'Ada',
    'x-musterd-session-lease': ada.sessionLease,
  });
  async function post(path: string, body: unknown, headers: Record<string, string>) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }
  const team = async () => (await getTeamBySlug(server.store, 'dawn'))!;
  const gateRows = async () =>
    (await listAudit(server.store, (await team()).id))
      .filter((a) => a.action === 'lane.gate')
      .map((a) => (typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail));
  const path = (target: string, posture: 'block' | 'warn' = 'block') => ({
    class: posture === 'block' ? 'protocol' : 'packages',
    // A fingerprint that does not spell the path, so the shapes-only check below means something.
    fingerprint: `fp-${target.length}-${target.at(-4)}`,
    posture,
    target,
  });

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const created = await post(
      '/teams',
      { slug: 'dawn', creator: { name: 'nick', kind: 'human' } },
      {},
    );
    const nickCred = created.json.human_credential;
    await post(
      '/teams/dawn/members',
      { name: 'Ada', kind: 'agent' },
      { authorization: `Bearer ${nickCred}` },
    );
    ada = await claimAgentHttp(base, 'dawn', created.json.agent_key, nickCred, 'Ada');
  });

  afterEach(async () => {
    await server.close();
  });

  describe('§2 — several paths in one call', () => {
    it('an owned first path does not let an unowned second one through; one row records the deny', async () => {
      await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'own a',
        scope: ['src/a.ts'],
        claim: true,
      });
      const r = await post(
        '/teams/dawn/gate',
        {
          kind: 'contended-surface',
          tool: 'Bash',
          ...path('src/a.ts'),
          also: [path('src/b.ts')],
        },
        seat(),
      );
      expect(r.status).toBe(200);
      expect(r.json.decision).toBe('deny');
      expect(r.json.reason).toContain('src/b.ts');
      const rows = await gateRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: 'denied',
        fingerprint: path('src/b.ts').fingerprint,
        tool: 'Bash',
        targets: 2,
      });
    });

    it('all owned → allowed, one row', async () => {
      await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'own src',
        scope: ['src/**'],
        claim: true,
      });
      const r = await post(
        '/teams/dawn/gate',
        {
          kind: 'contended-surface',
          tool: 'Bash',
          ...path('src/a.ts'),
          also: [path('src/b.ts')],
        },
        seat(),
      );
      expect(r.json).toMatchObject({ decision: 'allow', outcome: 'allowed' });
      expect(await gateRows()).toHaveLength(1);
    });
  });

  describe('§3 — after the call', () => {
    const after = (target: string) =>
      post(
        '/teams/dawn/gate',
        { kind: 'contended-surface', tool: 'Bash', ...path(target), after: true },
        seat(),
      );

    it('an unowned changed path is written_unowned, with the repair, and audited without the path', async () => {
      const r = await after('src/a.ts');
      expect(r.json.decision).toBe('allow');
      expect(r.json.outcome).toBe('written_unowned');
      expect(r.json.reason).toContain("changed 'src/a.ts'");
      expect(r.json.reason).toContain('git checkout -- src/a.ts');
      const rows = await gateRows();
      expect(rows).toEqual([
        expect.objectContaining({ outcome: 'written_unowned', class: 'protocol' }),
      ]);
      expect(JSON.stringify(rows)).not.toContain('src/a.ts');
    });

    it('a path the seat’s lane covers is allowed and records nothing', async () => {
      await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'own src',
        scope: ['src/**'],
        claim: true,
      });
      const r = await after('src/a.ts');
      expect(r.json.outcome).toBe('allowed');
      expect(await gateRows()).toEqual([]);
    });
  });
});
