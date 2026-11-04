import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('gate-withhold-http', (_o, kind) => {
  /**
   * ADR 801 end to end over HTTP: a seat's own blocking approve ask is served back to it on
   * `GET /enforcement` as a withhold, `POST /gate` with `kind: 'ask-withhold'` denies while it is open,
   * and a human accept or the seat's own withdrawal releases it. Another member never sees it.
   */
  let server: RunningServer;
  let base: string;
  let nickCred: string;
  let ada: AgentHttpAuth;

  const seat = () => ({
    authorization: `Bearer ${ada.key}`,
    'x-musterd-seat': 'Ada',
    'x-musterd-session-lease': ada.sessionLease,
  });
  const bearer = (auth: string) => ({ authorization: `Bearer ${auth}` });
  async function post(path: string, body: unknown, headers: Record<string, string>) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }
  async function get(path: string, headers: Record<string, string>) {
    const res = await fetch(base + path, { headers });
    return (await res.json()) as any;
  }
  const send = (
    from: string,
    headers: Record<string, string>,
    fields: Record<string, unknown> & { id: string; act: string },
  ) =>
    post(
      '/teams/dawn/messages',
      {
        envelope: makeEnvelope({
          team: 'dawn',
          from,
          to: { kind: 'member', name: from === 'Ada' ? 'nick' : 'Ada' },
          body: 'x',
          ...fields,
        } as never),
      },
      headers,
    );
  const raise = (id: string, meta: Record<string, unknown> = {}) =>
    send('Ada', seat(), {
      id,
      act: 'ask',
      body: 'may I cut the release?',
      meta: { species: 'approve', tier: 'blocking', ...meta },
    });
  const gate = (askRef: string, target = 'gh release create v1') =>
    post(
      '/teams/dawn/gate',
      {
        kind: 'ask-withhold',
        class: 'ask-withhold',
        fingerprint: 'fp-withhold',
        posture: 'block',
        tool: 'Bash',
        target,
        ask_ref: askRef,
      },
      seat(),
    );

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const team = await post(
      '/teams',
      { slug: 'dawn', creator: { name: 'nick', kind: 'human' } },
      {},
    );
    nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, bearer(nickCred));
    ada = await claimAgentHttp(base, 'dawn', team.json.agent_key, nickCred, 'Ada');
  });

  afterEach(async () => {
    await server.close();
  });

  describe('GET /enforcement serves the caller its own withholds', () => {
    it('a scoped ask comes back with its globs; a seat-wide one with none', async () => {
      expect((await raise('ask-scoped', { withhold: { commands: ['gh release *'] } })).status).toBe(
        201,
      );
      expect((await raise('ask-wide')).status).toBe(201);
      const { withholds } = await get('/teams/dawn/enforcement', seat());
      expect(withholds.map((w: any) => [w.ask_id, w.seat_wide, w.commands]).sort()).toEqual([
        ['ask-scoped', false, ['gh release *']],
        ['ask-wide', true, []],
      ]);
    });

    it('another member never sees a seat’s withholds', async () => {
      await raise('ask-wide');
      const { withholds } = await get('/teams/dawn/enforcement', bearer(nickCred));
      expect(withholds).toEqual([]);
    });
  });

  describe('POST /gate kind ask-withhold', () => {
    it('denies while the ask is open, and records cause ask_withhold on the audit row', async () => {
      await raise('ask-1');
      const r = await gate('ask-1');
      expect(r.json.decision).toBe('deny');
      expect(r.json.outcome).toBe('denied_awaiting');
      expect(r.json.reason).toContain('held by your own blocking ask ask-1');
      const team = (await getTeamBySlug(server.store, 'dawn'))!;
      const row = (await listAudit(server.store, team.id)).find((a) => a.action === 'action.gate');
      const detail = typeof row?.detail === 'string' ? JSON.parse(row.detail) : row?.detail;
      expect(detail).toMatchObject({ cause: 'ask_withhold', outcome: 'denied_awaiting' });
      expect(JSON.stringify(row?.detail)).not.toContain('gh release create v1');
    });

    it('a human accept releases it on the next call', async () => {
      await raise('ask-1');
      const a = await send('nick', bearer(nickCred), {
        id: 'ans-1',
        act: 'accept',
        meta: { in_reply_to: 'ask-1' },
      });
      expect(a.status).toBe(201);
      const r = await gate('ask-1');
      expect(r.json.decision).toBe('allow');
      expect(r.json.outcome).toBe('released');
    });

    it('a human decline keeps it refused', async () => {
      await raise('ask-1');
      await send('nick', bearer(nickCred), {
        id: 'ans-1',
        act: 'decline',
        meta: { in_reply_to: 'ask-1' },
      });
      const r = await gate('ask-1');
      expect(r.json.decision).toBe('deny');
      expect(r.json.outcome).toBe('denied_declined');
    });

    it('the seat withdrawing its own ask releases it', async () => {
      await raise('ask-1');
      const w = await send('Ada', seat(), {
        id: 'res-1',
        act: 'resolve',
        thread: 'ask-1',
        meta: { ask_ref: 'ask-1', ask_outcome: 'held' },
      });
      expect(w.status).toBe(201);
      const r = await gate('ask-1');
      expect(r.json.decision).toBe('allow');
    });

    it('an agent accept does not release it — only a human answer counts', async () => {
      await raise('ask-1');
      await send('Ada', seat(), { id: 'ans-1', act: 'accept', meta: { in_reply_to: 'ask-1' } });
      const r = await gate('ask-1');
      expect(r.json.decision).toBe('deny');
    });
  });
});
