import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { openLane } from '../store/lanes.js';
import { upsertRole } from '../store/roles.js';
import { getTeamBySlug, setPolicy } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('gate-http', (_o, kind) => {
  /**
   * Direct HTTP coverage for the ADR 150 enforcement foundation: the member-readable class table
   * (`GET /enforcement`) and the gate ingest (`POST /gate`). What's asserted is the foundation's
   * behavioral contract — member (not admin) read, the webhook never leaking through the scoped read,
   * the warn path proceeding with a `warned` audit outcome, the stubbed block path failing OPEN (never
   * wedging a seat), and the audit row being SHAPES ONLY (class + fingerprint, never the target text).
   */
  let server: RunningServer;
  let base: string;
  let agentKey: string;
  let nickCred: string;
  let agentAuthorities: Record<string, AgentHttpAuth>;

  function seatHeaders(seat: string): Record<string, string> {
    const auth = agentAuthorities[seat]!;
    return {
      authorization: `Bearer ${auth.key}`,
      'x-musterd-seat': seat,
      'x-musterd-session-lease': auth.sessionLease,
    };
  }
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }
  async function get(path: string, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, { headers });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }
  const bearer = (auth: string) => ({ authorization: `Bearer ${auth}` });

  const audits = async (action: string) => {
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    return (await listAudit(server.store, team.id)).filter((r) => r.action === action);
  };

  const CLASSES = [
    {
      class: 'src/tariff.ts',
      kind: 'contended-surface',
      match: ['src/tariff.ts'],
      posture: 'warn',
    },
    { class: 'merge-to-main', kind: 'costly-action', match: ['gh pr merge*'], posture: 'warn' },
    { class: 'force-push', kind: 'costly-action', match: ['git push --force*'], posture: 'block' },
  ];

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    agentKey = team.json.agent_key;
    nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, bearer(nickCred));
    agentAuthorities = {
      Ada: await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Ada'),
    };
    // Admin sets an enforcement class table (plus a secret webhook, to prove the scoped read hides it).
    await post(
      '/teams/dawn/policy',
      { enforcement: { classes: CLASSES }, ask_slack_webhook: 'https://hooks.slack.test/secret' },
      bearer(nickCred),
    );
  });

  afterEach(async () => {
    await server.close();
  });

  describe('GET /enforcement (ADR 150) — member-readable, webhook-scoped-out', () => {
    it('a member seat (not admin) can read the class table', async () => {
      const r = await get('/teams/dawn/enforcement', seatHeaders('Ada'));
      expect(r.status).toBe(200);
      expect(r.json.enforcement.classes).toHaveLength(3);
      expect(r.json.enforcement.classes[0].class).toBe('src/tariff.ts');
    });

    it('the scoped read never exposes the secret webhook (only enforcement is returned)', async () => {
      const r = await get('/teams/dawn/enforcement', seatHeaders('Ada'));
      expect(JSON.stringify(r.json)).not.toContain('secret');
      expect(r.json.ask_slack_webhook).toBeUndefined();
    });
  });

  describe('POST /gate (ADR 150) — adjudicate + shapes-only audit', () => {
    it('a warn-posture contended-surface match proceeds and records a warned lane.gate row', async () => {
      const r = await post(
        '/teams/dawn/gate',
        {
          kind: 'contended-surface',
          class: 'src/tariff.ts',
          fingerprint: 'abc123',
          posture: 'warn',
          tool: 'Edit',
          target: 'src/tariff.ts',
        },
        seatHeaders('Ada'),
      );
      expect(r.status).toBe(200);
      expect(r.json.decision).toBe('allow');
      expect(r.json.outcome).toBe('warned');
      const rows = await audits('lane.gate');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result).toBe('allow');
    });

    it('a warn-posture costly-action match records a warned action.gate row', async () => {
      const r = await post(
        '/teams/dawn/gate',
        {
          kind: 'costly-action',
          class: 'merge-to-main',
          fingerprint: 'def456',
          posture: 'warn',
          tool: 'Bash',
          target: 'gh pr merge 320 --squash',
        },
        seatHeaders('Ada'),
      );
      expect(r.json.outcome).toBe('warned');
      expect(await audits('action.gate')).toHaveLength(1);
    });

    it('the audit row is SHAPES ONLY — carries class + fingerprint, never the raw target text', async () => {
      await post(
        '/teams/dawn/gate',
        {
          kind: 'costly-action',
          class: 'force-push',
          fingerprint: 'ghi789',
          posture: 'block',
          tool: 'Bash',
          target: 'git push --force origin secret-branch-name',
        },
        seatHeaders('Ada'),
      );
      const row = (await audits('action.gate')).at(-1)!;
      const detail = JSON.parse(row.detail!);
      expect(detail.class).toBe('force-push');
      expect(detail.fingerprint).toBe('ghi789');
      expect(row.target).toBe('force-push'); // the class name, not the command
      // The raw command text never reaches any audit field.
      expect(JSON.stringify(row)).not.toContain('secret-branch-name');
    });

    it('rejects a malformed gate body (400)', async () => {
      const r = await post(
        '/teams/dawn/gate',
        { kind: 'not-a-kind', class: 'x' },
        seatHeaders('Ada'),
      );
      expect(r.status).toBe(400);
    });
  });

  describe('Gate A — lane-ownership (ADR 150)', async () => {
    const team = async () => (await getTeamBySlug(server.store, 'dawn'))!;
    const gateA = async (posture: 'warn' | 'block', target: string, seat = 'Ada') =>
      await post(
        '/teams/dawn/gate',
        {
          kind: 'contended-surface',
          class: 'src/tariff.ts',
          fingerprint: 'fp',
          posture,
          tool: 'Edit',
          target,
        },
        seatHeaders(seat),
      );

    it('owns a claimed lane covering the path → allow, quietly (no nag), under block', async () => {
      await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'tariff work',
        scope: ['src/**'],
        claim: true,
      });
      const r = await gateA('block', 'src/tariff.ts');
      expect(r.json.decision).toBe('allow');
      expect(r.json.outcome).toBe('allowed');
      expect(r.json.reason).toContain('tariff work');
    });

    it('no lane covering the path, block → DENY with a "claim one" repair', async () => {
      const r = await gateA('block', 'src/tariff.ts');
      expect(r.json.decision).toBe('deny');
      expect(r.json.outcome).toBe('denied');
      expect(r.json.reason).toContain('claim one');
      // The deny is recorded as a lane.gate row with result: deny.
      const row = (await audits('lane.gate')).at(-1)!;
      expect(row.result).toBe('deny');
    });

    it('ANOTHER seat owns the covering lane, block → DENY naming that owner', async () => {
      await post('/teams/dawn/members', { name: 'Bo', kind: 'agent' }, bearer(nickCred));
      await openLane(server.store, (await team()).id, 'dawn', 'Bo', {
        title: 'bo tariff',
        scope: ['src/tariff.ts'],
        claim: true,
      });
      const r = await gateA('block', 'src/tariff.ts');
      expect(r.json.decision).toBe('deny');
      expect(r.json.reason).toContain('owned by Bo');
    });

    it('no lane, warn → allow with the advisory (ADR 083 default preserved)', async () => {
      const r = await gateA('warn', 'src/tariff.ts');
      expect(r.json.decision).toBe('allow');
      expect(r.json.outcome).toBe('warned');
    });

    it('owns the lane, warn → quiet allow (ownership means no advisory either)', async () => {
      await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'ada tariff',
        scope: ['src/tariff.ts'],
        claim: true,
      });
      const r = await gateA('warn', 'src/tariff.ts');
      expect(r.json.outcome).toBe('allowed');
    });

    it('a resolved (done) lane does not count as ownership — only contending lanes cover', async () => {
      const lane = await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'old tariff',
        scope: ['src/**'],
        claim: true,
      });
      await server.store.run('UPDATE lanes SET state = ? WHERE id = ?', ['done', lane.id]);
      const r = await gateA('block', 'src/tariff.ts');
      expect(r.json.decision).toBe('deny'); // done lane ≠ ownership
    });
  });

  describe('Gate A — a lane that names a file holds it, first claim first (ADR 691)', async () => {
    const team = async () => (await getTeamBySlug(server.store, 'dawn'))!;
    const gateA = async (posture: 'warn' | 'block', target: string, seat = 'Ada') =>
      await post(
        '/teams/dawn/gate',
        {
          kind: 'contended-surface',
          class: 'src/tariff.ts',
          fingerprint: 'fp',
          posture,
          tool: 'Edit',
          target,
        },
        seatHeaders(seat),
      );
    const bo = async () => {
      await post('/teams/dawn/members', { name: 'Bo', kind: 'agent' }, bearer(nickCred));
      agentAuthorities['Bo'] = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Bo');
    };

    it('both lanes name the file; the later claim is refused under block and warned under warn', async () => {
      await bo();
      await openLane(server.store, (await team()).id, 'dawn', 'Bo', {
        title: 'bo first',
        scope: ['src/tariff.ts'],
        claim: true,
      });
      await new Promise((r) => setTimeout(r, 5));
      await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'ada second',
        scope: ['src/tariff.ts'],
        claim: true,
      });
      const blocked = await gateA('block', 'src/tariff.ts');
      expect(blocked.json.decision).toBe('deny');
      expect(blocked.json.reason).toContain('held by Bo');
      expect(blocked.json.reason).toContain('hand it off');
      const warned = await gateA('warn', 'src/tariff.ts');
      expect(warned.json.decision).toBe('allow');
      expect(warned.json.outcome).toBe('warned');
      expect(warned.json.reason).toContain('held by Bo');
      // The holder is allowed, quietly.
      const holder = await gateA('block', 'src/tariff.ts', 'Bo');
      expect(holder.json.outcome).toBe('allowed');
    });

    it('naming the file beats covering it through an area glob, whatever the claim order', async () => {
      await bo();
      await openLane(server.store, (await team()).id, 'dawn', 'Bo', {
        title: 'bo area',
        scope: ['src/**'],
        claim: true,
      });
      await new Promise((r) => setTimeout(r, 5));
      await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'ada names it',
        scope: ['src/tariff.ts'],
        claim: true,
      });
      expect((await gateA('block', 'src/tariff.ts', 'Ada')).json.outcome).toBe('allowed');
      const r = await gateA('block', 'src/tariff.ts', 'Bo');
      expect(r.json.decision).toBe('deny');
      expect(r.json.reason).toContain('held by Ada');
      // A file the named lane does not name is still Bo's by the covering rule.
      expect((await gateA('block', 'src/other.ts', 'Bo')).json.outcome).toBe('allowed');
    });

    it('the hold ends with the lane: a finished or released holder frees the file', async () => {
      await bo();
      const first = await openLane(server.store, (await team()).id, 'dawn', 'Bo', {
        title: 'bo first',
        scope: ['src/tariff.ts'],
        claim: true,
      });
      await new Promise((r) => setTimeout(r, 5));
      await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'ada second',
        scope: ['src/tariff.ts'],
        claim: true,
      });
      expect((await gateA('block', 'src/tariff.ts')).json.decision).toBe('deny');
      await server.store.run('UPDATE lanes SET state = ? WHERE id = ?', ['done', first.id]);
      expect((await gateA('block', 'src/tariff.ts')).json.outcome).toBe('allowed');
    });

    it('two area globs over one file hold nothing — ADR 150 covering ownership, unchanged', async () => {
      await bo();
      await openLane(server.store, (await team()).id, 'dawn', 'Bo', {
        title: 'bo area',
        scope: ['src/**'],
        claim: true,
      });
      await openLane(server.store, (await team()).id, 'dawn', 'Ada', {
        title: 'ada area',
        scope: ['src/*.ts'],
        claim: true,
      });
      expect((await gateA('block', 'src/tariff.ts', 'Ada')).json.outcome).toBe('allowed');
      expect((await gateA('block', 'src/tariff.ts', 'Bo')).json.outcome).toBe('allowed');
    });
  });

  describe('Gate B — policy-classed action→ask (ADR 150) — deny IS emit', async () => {
    // `force-push` is the block-posture costly-action class in CLASSES.
    const forcePush = async (target = 'git push --force origin feat/x') =>
      await post(
        '/teams/dawn/gate',
        {
          kind: 'costly-action',
          class: 'force-push',
          fingerprint: 'fp-force',
          posture: 'block',
          tool: 'Bash',
          target,
        },
        seatHeaders('Ada'),
      );

    /** A seat answers the raised ask (accept/decline naming it via meta.in_reply_to). `headers` carry the
     *  answerer's identity — a human's bearer cred, or an agent's key + seat header. */
    const answer = async (
      seat: string,
      headers: Record<string, string>,
      act: 'accept' | 'decline',
      askId: string,
    ) => {
      const env = makeEnvelope({
        id: `ans-${act}-${askId.slice(-4)}`,
        team: 'dawn',
        from: seat,
        to: { kind: 'member', name: seat },
        act,
        meta: { in_reply_to: askId },
      });
      return await post('/teams/dawn/messages', { envelope: env }, headers);
    };

    const askMessages = async () =>
      (await server.store.all<{ id: string; meta: string }>(
        `SELECT id, meta FROM messages WHERE team_id = ? AND act = 'ask'
           AND json_extract(meta, '$.gate.fingerprint') = 'fp-force'`,
        [(await getTeamBySlug(server.store, 'dawn'))!.id],
      )) as {
        id: string;
        meta: string;
      }[];

    it('first block attempt → DENY + emits ONE species:approve/tier:blocking ask carrying meta.gate', async () => {
      const r = await forcePush();
      expect(r.json.decision).toBe('deny');
      expect(r.json.outcome).toBe('denied_ask_raised');
      expect(r.json.reason).toContain('human approval');
      expect(r.json.ask_ref).toBeTruthy();

      const asks = await askMessages();
      expect(asks).toHaveLength(1);
      const meta = JSON.parse(asks[0]!.meta);
      expect(meta.species).toBe('approve');
      expect(meta.tier).toBe('blocking');
      expect(meta.gate).toMatchObject({ class: 'force-push', fingerprint: 'fp-force' });
      // The ask raised its ADR 147 lifecycle row.
      expect(await audits('ask.raised')).toHaveLength(1);
      // The gate decision recorded a denied_ask_raised action.gate row.
      expect((await audits('action.gate')).at(-1)!.result).toBe('deny');
    });

    it('the deny repair string carries the ADR 147 hold contract + names the route-around (finding 006 item 1)', async () => {
      const r = await forcePush();
      // Parity with the ask contract (shared askContractText): the HOLD instruction + held-outcome recording.
      expect(r.json.reason).toContain('HOLD');
      expect(r.json.reason).toContain("meta.ask_outcome='held'");
      expect(r.json.reason).toContain(r.json.ask_ref); // the ask id is threaded into the marching orders
      // What the deny alone must add: what the block is for, and that routing around defeats it.
      expect(r.json.reason).toContain('human review');
      expect(r.json.reason).toMatch(/local merge|another way|alternate path/);
      expect(r.json.reason).toMatch(/bypass/i);
    });

    it('with NO reachable unblocker the deny carries STRAND orders, not a dead-end hold (ADR 153)', async () => {
      // Make the room provably empty: drop the loud reach (nick, the admin human, has no live presence
      // in this fixture) and clear any ambient presence the setup's authed requests created. Ada is the
      // raiser, so no teammate term either — the FB3 shape.
      await setPolicy(server.store, (await getTeamBySlug(server.store, 'dawn'))!.id, {
        enforcement: { classes: CLASSES as never },
      });
      await server.store.run('DELETE FROM presence');
      agentAuthorities.Ada = await claimAgentHttp(
        base,
        'dawn',
        agentKey,
        nickCred,
        'Ada',
        agentAuthorities.Ada.key,
      );
      const r = await forcePush();
      expect(r.json.decision).toBe('deny'); // still non-proceed: strand is a second way of NOT proceeding
      expect(r.json.reason).toContain('STRAND');
      expect(r.json.reason).toContain("meta.ask_outcome='stranded'");
      expect(r.json.reason).toContain('release the lane');
      expect(r.json.reason).not.toContain('HOLD');
      // Guard (ADR 153 eval): the blocked action still never executes — a re-attempt after the strand
      // orders re-adjudicates to deny, not allow.
      await server.store.run('DELETE FROM presence');
      agentAuthorities.Ada = await claimAgentHttp(
        base,
        'dawn',
        agentKey,
        nickCred,
        'Ada',
        agentAuthorities.Ada.key,
      );
      const again = await forcePush();
      expect(again.json.decision).toBe('deny');
      expect(again.json.outcome).toBe('denied_awaiting');
    });

    it('re-attempt while unanswered → DENY (denied_awaiting), does NOT raise a second ask (dedup)', async () => {
      const first = await forcePush();
      const r = await forcePush(); // same fingerprint, human has not answered
      expect(r.json.decision).toBe('deny');
      expect(r.json.outcome).toBe('denied_awaiting');
      expect(r.json.ask_ref).toBe(first.json.ask_ref);
      expect(await askMessages()).toHaveLength(1); // still ONE ask
    });

    it('re-attempt after a HUMAN accept → ALLOW (released), standing per-fingerprint', async () => {
      const first = await forcePush();
      const a = await answer('nick', bearer(nickCred), 'accept', first.json.ask_ref);
      expect(a.status).toBe(201);
      const r = await forcePush();
      expect(r.json.decision).toBe('allow');
      expect(r.json.outcome).toBe('released');
      expect(r.json.reason).toContain('approved by nick');
    });

    it('re-attempt after a HUMAN decline → stays DENIED (denied_declined), do not re-raise', async () => {
      const first = await forcePush();
      await answer('nick', bearer(nickCred), 'decline', first.json.ask_ref);
      const r = await forcePush();
      expect(r.json.decision).toBe('deny');
      expect(r.json.outcome).toBe('denied_declined');
      expect(r.json.reason).toContain('declined by nick');
      expect(await askMessages()).toHaveLength(1); // no second ask on decline
    });

    it('an AGENT accept does NOT release the gate — only a human accept counts', async () => {
      const first = await forcePush();
      // Ada (the acting agent) tries to self-approve — a valid message, but not a human accept.
      const a = await answer('Ada', seatHeaders('Ada'), 'accept', first.json.ask_ref);
      expect(a.status).toBe(201);
      const r = await forcePush();
      expect(r.json.decision).toBe('deny');
      expect(r.json.outcome).toBe('denied_awaiting'); // still awaiting a HUMAN
    });

    it('the ask body carries the target (delivery carries bodies) while the audit row stays shapes-only', async () => {
      await forcePush('git push --force origin secret-branch');
      const meta = await askMessages();
      // body is delivery, not audit: the ask names the exact action for the human.
      const askRow = (await server.store.get(`SELECT body FROM messages WHERE id = ?`, [
        meta[0]!.id,
      ])) as {
        body: string;
      };
      expect(askRow.body).toContain('secret-branch');
      // but the action.gate audit row never carries the command text.
      expect(JSON.stringify(await audits('action.gate'))).not.toContain('secret-branch');
    });
  });

  // ADR 513 — a route only a role's holders may run (the courier's Taildrop, 2026-10-04). The daemon
  // reads the role from the TEAM'S policy, never from the request, and names the holders in the deny.
  describe('Role-gated routes (ADR 513)', async () => {
    const ROUTE = {
      class: 'taildrop',
      kind: 'role-route',
      role: 'courier',
      match: ['tailscale file cp *'],
      posture: 'block',
    };
    const routeReq = (posture: 'warn' | 'block') => ({
      kind: 'role-route',
      class: 'taildrop',
      fingerprint: 'tail01',
      posture,
      tool: 'Bash',
      target: 'tailscale file cp data.jsonl laptop:',
    });

    async function withRoute(posture: 'warn' | 'block') {
      await post(
        '/teams/dawn/policy',
        { enforcement: { classes: [{ ...ROUTE, posture }] } },
        bearer(nickCred),
      );
      await post(
        '/teams/dawn/members',
        { name: 'Dolly', kind: 'agent', role: 'courier' },
        bearer(nickCred),
      );
      agentAuthorities['Dolly'] = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Dolly');
    }

    it('a seat that does not hold the role, block → DENY naming the holder and the ask', async () => {
      await withRoute('block');
      const r = await post('/teams/dawn/gate', routeReq('block'), seatHeaders('Ada'));
      expect(r.json.decision).toBe('deny');
      expect(r.json.outcome).toBe('denied');
      expect(r.json.reason).toMatch(/taildrop/);
      expect(r.json.reason).toMatch(/Dolly holds courier/);
      expect(r.json.reason).toMatch(/request_help/);
      expect(r.json.reason).toContain('.agents/skills/courier/SKILL.md');
      const rows = await audits('action.gate');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result).toBe('deny');
      const detail = rows[0]!.detail;
      expect(typeof detail === 'string' ? JSON.parse(detail) : detail).toMatchObject({
        kind: 'role-route',
        role: 'courier',
      });
      expect(JSON.stringify(rows)).not.toContain('data.jsonl');
    });

    it('the deny points at the skill the role names, not its name (ADR 586 §3)', async () => {
      await withRoute('block');
      const team = await getTeamBySlug(server.store, 'dawn');
      await upsertRole(server.store, team!.id, 'courier', {}, null, null, 'file-moves');
      const r = await post('/teams/dawn/gate', routeReq('block'), seatHeaders('Ada'));
      expect(r.json.reason).toContain('.agents/skills/file-moves/SKILL.md');
    });

    it('the holder runs the route → quiet allow', async () => {
      await withRoute('block');
      const r = await post('/teams/dawn/gate', routeReq('block'), seatHeaders('Dolly'));
      expect(r.json).toMatchObject({ decision: 'allow', outcome: 'allowed' });
    });

    it('warn posture → a non-holder proceeds with the holder named (ADR 227 ramp)', async () => {
      await withRoute('warn');
      const r = await post('/teams/dawn/gate', routeReq('warn'), seatHeaders('Ada'));
      expect(r.json).toMatchObject({ decision: 'allow', outcome: 'warned' });
      expect(r.json.reason).toMatch(/Dolly holds courier/);
    });

    it('the role comes from the policy: a request claiming warn on a block class is still denied', async () => {
      await withRoute('block');
      const r = await post('/teams/dawn/gate', routeReq('warn'), seatHeaders('Ada'));
      expect(r.json.decision).toBe('deny');
    });

    it('no seat holds the role → the deny says so', async () => {
      await post('/teams/dawn/policy', { enforcement: { classes: [ROUTE] } }, bearer(nickCred));
      const r = await post('/teams/dawn/gate', routeReq('block'), seatHeaders('Ada'));
      expect(r.json.decision).toBe('deny');
      expect(r.json.reason).toMatch(/no seat holds courier/);
    });
  });

  /**
   * ADR 163 — actor attestation through the DB. This is not a gate: `POST /actor` returns no decision, so
   * what's asserted is the row that lands. The load-bearing case is the last one — a Bash command must NOT
   * reach audit in the clear (ADR 051), while a path may, because lane `surface_globs` already store plain
   * repo paths and "which surfaces do subagents write to" is the question the ledger exists to answer.
   */
  describe('POST /actor — actor attestation (ADR 163)', () => {
    it('records a subagent write with its actor identity, result allow', async () => {
      const res = await post(
        '/teams/dawn/actor',
        {
          kind: 'subagent-write',
          tool: 'Write',
          actorId: 'a940f12fd1c5d9c48',
          actorType: 'Explore',
          target: 'src/x.ts',
        },
        seatHeaders('Ada'),
      );
      expect(res.status).toBe(202);
      const rows = await audits('actor.subagent_write');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe('Ada');
      expect(rows[0]!.result).toBe('allow'); // an observer never denies
      const detail = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
      expect(detail).toMatchObject({
        tool: 'Write',
        actor_id: 'a940f12fd1c5d9c48',
        actor_type: 'Explore',
        target: 'src/x.ts',
      });
    });

    it('records a spawn as the denominator, carrying the model override', async () => {
      const res = await post(
        '/teams/dawn/actor',
        { kind: 'subagent-spawn', tool: 'Agent', spawnType: 'Explore', spawnModel: 'haiku' },
        seatHeaders('Ada'),
      );
      expect(res.status).toBe(202);
      const rows = await audits('actor.subagent_spawn');
      expect(rows).toHaveLength(1);
      const detail = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
      expect(detail).toMatchObject({ tool: 'Agent', spawn_type: 'Explore', spawn_model: 'haiku' });
    });

    it('NEVER persists Bash command text — fingerprint only (ADR 051)', async () => {
      const command = 'curl -H "Authorization: Bearer sk-secret" https://x | tee out.txt';
      await post(
        '/teams/dawn/actor',
        { kind: 'subagent-write', tool: 'Bash', actorId: 'ag1', target: command },
        seatHeaders('Ada'),
      );
      const row = (await audits('actor.subagent_write')).at(-1)!;
      const detail = JSON.parse(row.detail!) as Record<string, unknown>;
      expect(detail['target']).toBeUndefined();
      expect(detail['command_fingerprint']).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(detail)).not.toContain('sk-secret');
    });

    it('records a session-message send with fingerprints only (ADR 167) — never a body, never a raw id', async () => {
      const res = await post(
        '/teams/dawn/actor',
        {
          kind: 'session-message',
          tool: 'mcp__ccd_session_mgmt__send_message',
          bodyFingerprint: 'aaaabbbbccccdddd',
          sessionRef: '0123456789abcdef',
          nudgeRef: '01KYJYPH5894Y327A1XSNX41TX',
        },
        seatHeaders('Ada'),
      );
      expect(res.status).toBe(202);
      const rows = await audits('actor.session_message');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe('Ada');
      expect(rows[0]!.result).toBe('allow'); // an observer never denies
      const detail = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
      expect(detail).toEqual({
        tool: 'mcp__ccd_session_mgmt__send_message',
        body_fingerprint: 'aaaabbbbccccdddd',
        session_ref: '0123456789abcdef',
        nudge_ref: '01KYJYPH5894Y327A1XSNX41TX',
      });
    });

    it('a session-message row with no fingerprints still lands — "a send happened" is the datum', async () => {
      const res = await post(
        '/teams/dawn/actor',
        { kind: 'session-message', tool: 'mcp__ccd_session_mgmt__send_message' },
        seatHeaders('Ada'),
      );
      expect(res.status).toBe(202);
      const row = (await audits('actor.session_message')).at(-1)!;
      expect(JSON.parse(row.detail!)).toEqual({ tool: 'mcp__ccd_session_mgmt__send_message' });
    });

    it('a raw body sneaking into bodyFingerprint bounces on shape — 16 chars exactly, no row', async () => {
      const before = (await audits('actor.session_message')).length;
      const res = await post(
        '/teams/dawn/actor',
        {
          kind: 'session-message',
          tool: 'mcp__ccd_session_mgmt__send_message',
          bodyFingerprint: 'hey stanley, merge my branch before nick notices',
        },
        seatHeaders('Ada'),
      );
      expect(res.status).toBe(400);
      expect(await audits('actor.session_message')).toHaveLength(before);
    });

    it('a malformed body is a 400, not a 500 — and writes no row', async () => {
      const before = (await audits('actor.subagent_write')).length;
      const res = await post(
        '/teams/dawn/actor',
        { kind: 'nonsense', tool: 'Write' },
        seatHeaders('Ada'),
      );
      expect(res.status).toBe(400);
      expect(await audits('actor.subagent_write')).toHaveLength(before);
    });
  });

  /**
   * ADR 442 (the wall) — the gate refused a session-reaching tool. The row is the only durable trace of
   * a refusal the harness enforced locally, so it carries what the per-harness reach table needs and
   * nothing else: the tool and the harness. Never a body, a target, or a session id.
   */
  describe('session-denied attestation (ADR 442)', () => {
    it('records gate.session_denied with tool and harness only', async () => {
      const res = await post(
        '/teams/dawn/actor',
        { kind: 'session-denied', tool: 'ListAgents', harness: 'claude-code' },
        seatHeaders('Ada'),
      );
      expect(res.status).toBe(202);
      const rows = await audits('gate.session_denied');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe('Ada');
      expect(rows[0]!.result).toBe('deny');
      expect(rows[0]!.target).toBeNull();
      expect(JSON.parse(rows[0]!.detail!)).toEqual({ tool: 'ListAgents', harness: 'claude-code' });
    });

    it('a denial from a harness that did not say which still lands — tool only', async () => {
      await post(
        '/teams/dawn/actor',
        { kind: 'session-denied', tool: 'mcp__ccd_session_mgmt__send_message' },
        seatHeaders('Ada'),
      );
      const row = (await audits('gate.session_denied')).at(-1)!;
      expect(JSON.parse(row.detail!)).toEqual({ tool: 'mcp__ccd_session_mgmt__send_message' });
    });

    it('a session-message naming a real act is no longer confirmed as a relay (ADR 167 inc 2 retired)', async () => {
      const envelope = makeEnvelope({
        id: '01HTESTNDGEAAAAAAAAAAAAAAA',
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'nick' },
        act: 'handoff',
        body: 'x',
      });
      await post('/teams/dawn/messages', { envelope }, seatHeaders('Ada'));
      await post(
        '/teams/dawn/actor',
        {
          kind: 'session-message',
          tool: 'mcp__ccd_session_mgmt__send_message',
          nudgeRef: envelope.id,
          bodyFingerprint: 'aaaabbbbccccdddd',
        },
        seatHeaders('Ada'),
      );
      const detail = JSON.parse((await audits('actor.session_message')).at(-1)!.detail!);
      expect(detail['nudge']).toBeUndefined();
      expect(detail['verbatim']).toBeUndefined();
    });

    it('records gate.unenforced when a seat flushes its local outage counter on recovery (ADR 674)', async () => {
      const r = await post(
        '/teams/dawn/actor',
        {
          kind: 'unenforced',
          tool: 'Edit',
          count: 4,
          since_ts: 1_700_000_000_000,
          until_ts: 1_700_000_030_000,
        },
        seatHeaders('Ada'),
      );
      expect(r.status).toBe(202);
      const rows = await audits('gate.unenforced');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe('Ada');
      expect(rows[0]!.result).toBe('allow');
      expect(JSON.parse(rows[0]!.detail!)).toEqual({
        count: 4,
        tool: 'Edit',
        since_ts: 1_700_000_000_000,
        until_ts: 1_700_000_030_000,
      });
    });
  });
});
