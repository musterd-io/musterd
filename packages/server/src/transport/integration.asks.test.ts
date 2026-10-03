import { PROTOCOL_VERSION } from '@musterd/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import { withDrivers } from '../db/testing.js';
import { flushLapsedHolds } from '../notify/doorbell.js';
import { setSinkPostForTests } from '../notify/pinnedPost.js';
import { listAudit } from '../store/audit.js';
import {
  DOORBELL_RING_RETENTION_MS,
  insertRing,
  listRings,
  pruneRings,
  setDoorbellPrefs,
} from '../store/doorbell.js';
import { getMemberById, getMemberByName, setMemberGovernance } from '../store/members.js';
import { getTeamById, getTeamBySlug } from '../store/teams.js';
import { integrationHarness, type Auth } from './integration.helpers.js';

withDrivers('integration · asks', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, get, pollUntil, post, req, teamBootstraps } = h;

  describe('the to-human ask stream (ADR 147)', () => {
    /** Build a schema-shaped envelope for POST /messages (the harness posts raw envelopes). */
    function env(
      from: string,
      to: unknown,
      act: string,
      meta: Record<string, unknown>,
      id: string,
    ) {
      return {
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to,
        act,
        body: '',
        meta,
        ts: Date.now(),
      };
    }

    it('raises ask.raised carrying species+tier and lands the ask in the admin inbox', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
      const ada = { key: team.json.agent_key, seat: 'Ada' };

      const sent = await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'ask',
            { species: 'escalate', tier: 'blocking' },
            'ask-1',
          ),
        },
        ada,
      );
      expect(sent.status).toBe(201);

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const raised = (await listAudit(h.server.store, teamId)).find(
        (r) => r.action === 'ask.raised',
      );
      expect(raised).toBeDefined();
      expect(JSON.parse(raised!.detail!)).toMatchObject({ species: 'escalate', tier: 'blocking' });

      // The durable reach: the admin (creator) sees the ask waiting in their inbox.
      const inbox = await get('/teams/dawn/inbox', nickCred);
      expect(inbox.json.messages.some((m: any) => m.id === 'ask-1' && m.act === 'ask')).toBe(true);
    });

    it('pushes a member-directed ask to a live admin too (guaranteed reach, §3)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickCred); // a non-admin human
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
      const ada = { key: team.json.agent_key, seat: 'Ada' };

      // nick (admin) is live on WS but NOT a firehose subscriber — the only path to them is deliverToAdmins.
      const nick = new TestWs();
      await nick.open();
      await nick.claim('dawn', nickCred, 'nick', 'cli');

      // Ada asks a *non-admin* human — nick is not a recipient, yet must still receive it (asks route to admins).
      await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'member', name: 'bo' },
            'ask',
            { species: 'consult', tier: 'standard' },
            'ask-2',
          ),
        },
        ada,
      );
      const deliver = await nick.waitFor('deliver');
      expect((deliver as any).envelope.id).toBe('ask-2');
      expect((deliver as any).envelope.act).toBe('ask');
      nick.close();
    });

    it('records the no-answer resolutions and the human "deciding" reply', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;

      // Below-top ask timed out unanswered → the agent proceeds, recording what it risked.
      await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'status_update',
            {
              ask_ref: 'ask-x',
              ask_outcome: 'risk_accepted',
              risk: 'may re-run a migration',
              chosen_approach: 'ran it idempotently behind a guard',
            },
            'res-1',
          ),
        },
        ada,
      );
      // Top-tier ask timed out → the agent holds, does not proceed.
      await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'status_update',
            { ask_ref: 'ask-y', ask_outcome: 'held' },
            'res-2',
          ),
        },
        ada,
      );
      // The human answers "deciding — check back in 1h" (rides `wait`).
      await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'nick',
            { kind: 'member', name: 'Ada' },
            'wait',
            { ask_ref: 'ask-y', until: '1h' },
            'res-3',
          ),
        },
        nickCred,
      );

      const audit = await listAudit(h.server.store, teamId);
      const risk = audit.find((r) => r.action === 'ask.risk_accepted');
      expect(JSON.parse(risk!.detail!)).toMatchObject({
        ask_ref: 'ask-x',
        risk: 'may re-run a migration',
        chosen_approach: 'ran it idempotently behind a guard',
        human_unreachable: true,
      });
      expect(audit.some((r) => r.action === 'ask.held')).toBe(true);
      const deferred = audit.find((r) => r.action === 'ask.deferred');
      expect(JSON.parse(deferred!.detail!)).toMatchObject({ ask_ref: 'ask-y', until: '1h' });

      // ADR 153: the strand terminal — top-tier timeout with no reachable unblocker; the agent released
      // its lane and stopped. One `ask.stranded` row carrying the reason makes the dead-end queryable.
      await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'status_update',
            { ask_ref: 'ask-z', ask_outcome: 'stranded' },
            'res-4',
          ),
        },
        ada,
      );
      const stranded = (await listAudit(h.server.store, teamId)).find(
        (r) => r.action === 'ask.stranded',
      );
      expect(JSON.parse(stranded!.detail!)).toMatchObject({
        ask_ref: 'ask-z',
        reason: 'no_reachable_unblocker',
      });
    });

    it('an ask ack carries the derived contract with the reachability projection (ADR 153 §1)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, undefined, team.json.token);
      const ada = { key: team.json.agent_key, seat: 'Ada' };

      const res = await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'ask',
            { species: 'approve', tier: 'blocking' },
            'ask-r-1',
          ),
        },
        ada,
      );
      expect(res.status).toBe(201);
      // nick (the creator, admin human) exists but has no live presence and no loud reach is wired, and
      // Ada is the raiser with no live teammate — provably unreachable: the FB3 shape.
      expect(res.json.ask_contract).toMatchObject({
        timeout_ms: 15 * 60_000,
        no_answer: 'hold',
        unblocker_reachable: false,
      });
      // A non-ask ack stays contract-free (additive — nothing rides responses that don't need it).
      const plain = await post(
        '/teams/dawn/messages',
        { envelope: env('Ada', { kind: 'team' }, 'status_update', null, 'su-r-1') },
        ada,
      );
      expect(plain.json.ask_contract).toBeUndefined();
    });

    it('round-trips the ask_fallback_to_nonadmin team policy (default off)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      expect(team.json.policy.ask_fallback_to_nonadmin).toBe(false);

      const set = await post('/teams/dawn/policy', { ask_fallback_to_nonadmin: true }, nickCred);
      expect(set.json.policy.ask_fallback_to_nonadmin).toBe(true);
      // Setting the ask knob must not clobber the other policy defaults (read-merge-write).
      expect(set.json.policy.standing_reseat_known_agents).toBe(false);
      const got = await get('/teams/dawn/policy', nickCred);
      expect(got.json.policy.ask_fallback_to_nonadmin).toBe(true);
    });
  });

  describe('ask surfaces — Slack delivery (ADR 149, via the ADR 443 doorbell)', () => {
    function env(
      from: string,
      to: unknown,
      act: string,
      meta: Record<string, unknown>,
      id: string,
    ) {
      return {
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to,
        act,
        body: 'need a call',
        meta,
        ts: Date.now(),
      };
    }

    /** Replace the sink transport at its seam (the test hooks host does not resolve, and the real
     *  transport resolves-and-pins); the test server's own fetch is untouched. */
    function stubSlack(handler: (body: { text: string }) => Response | Promise<Response>) {
      const calls: { url: string; text: string }[] = [];
      setSinkPostForTests(async (url, raw) => {
        const body = JSON.parse(raw) as { text: string };
        calls.push({ url, text: body.text });
        // A throwing handler is the dead endpoint: the real transport maps that to ok:false.
        try {
          const res = await handler(body);
          return { ok: res.ok, status: res.status };
        } catch {
          return { ok: false };
        }
      });
      return calls;
    }

    afterEach(() => setSinkPostForTests(null));

    it('posts a raised ask to the configured webhook and audits doorbell.surfaced ok:true', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
      await post(
        '/teams/dawn/policy',
        { ask_slack_webhook: 'https://hooks.slack.test/T/B/x' },
        nickCred,
      );
      // ADR 155 Inc 2: the at-raise fire is the not-present-admin case — pin nick off_hours so this
      // test can't be flipped quiet by an incidental presence touch. (Not `away`: since ADR 443 a
      // self-set away HOLDS the ring until he is back; off_hours is not a hold.)
      await post('/teams/dawn/availability', { status: 'off_hours' }, nickCred);
      const calls = stubSlack(() => new Response('ok', { status: 200 }));

      const sent = await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'ask',
            { species: 'escalate', tier: 'blocking' },
            'ask-s1',
          ),
        },
        { key: team.json.agent_key, seat: 'Ada' },
      );
      expect(sent.status).toBe(201);

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      await pollUntil(async () =>
        (await listAudit(h.server.store, teamId)).some((r) => r.action === 'doorbell.surfaced'),
      );
      const surfaced = (await listAudit(h.server.store, teamId)).find(
        (r) => r.action === 'doorbell.surfaced',
      )!;
      expect(JSON.parse(surfaced.detail!)).toMatchObject({
        surface: 'slack',
        ok: true,
        status: 200,
      });
      // The URL is a secret — the audit row must not carry it.
      expect(surfaced.detail).not.toContain('hooks.slack.test');

      expect(calls).toHaveLength(1);
      expect(calls[0]!.text).toContain('[dawn] Ada escalated to you');
      expect(calls[0]!.text).toContain('blocking — holds after 15m');
      expect(calls[0]!.text).toContain('need a call');
    });

    it('a dead webhook cannot fail the send — 201 anyway, doorbell.surfaced ok:false', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
      await post(
        '/teams/dawn/policy',
        { ask_slack_webhook: 'https://hooks.slack.test/T/B/dead' },
        nickCred,
      );
      await post('/teams/dawn/availability', { status: 'off_hours' }, nickCred);
      stubSlack(() => {
        throw new Error('ECONNREFUSED');
      });

      const sent = await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'ask',
            { species: 'consult', tier: 'advisory' },
            'ask-s2',
          ),
        },
        { key: team.json.agent_key, seat: 'Ada' },
      );
      expect(sent.status).toBe(201);

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      await pollUntil(async () =>
        (await listAudit(h.server.store, teamId)).some((r) => r.action === 'doorbell.surfaced'),
      );
      const surfaced = (await listAudit(h.server.store, teamId)).find(
        (r) => r.action === 'doorbell.surfaced',
      )!;
      expect(JSON.parse(surfaced.detail!)).toMatchObject({ surface: 'slack', ok: false });
    });

    it('fires no outbound call and writes no doorbell.surfaced row when the knob is unset (default off)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
      const calls = stubSlack(() => new Response('ok', { status: 200 }));

      await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'ask',
            { species: 'approve', tier: 'standard' },
            'ask-s3',
          ),
        },
        { key: team.json.agent_key, seat: 'Ada' },
      );

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      // The raised row proves the ask routed; give the (nonexistent) dispatch a beat, then assert silence.
      expect((await listAudit(h.server.store, teamId)).some((r) => r.action === 'ask.raised')).toBe(
        true,
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toHaveLength(0);
      expect(
        (await listAudit(h.server.store, teamId)).some((r) => r.action === 'doorbell.surfaced'),
      ).toBe(false);
    });

    // ── ADR 155 Increment 2: presence informs the ask clock, never the ceiling ──

    it('stays quiet at raise while an admin human is present — the loud surface waits for the re-notify', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
      await post(
        '/teams/dawn/policy',
        { ask_slack_webhook: 'https://hooks.slack.test/T/B/x' },
        nickCred,
      );
      // Make the admin PRESENT: an explicit presence row (the /presence ping) composes him working/idle.
      await post('/teams/dawn/presence', { surface: 'web' }, nickCred);
      const calls = stubSlack(() => new Response('ok', { status: 200 }));

      const sent = await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'ask',
            { species: 'escalate', tier: 'blocking' },
            'ask-p1',
          ),
        },
        { key: team.json.agent_key, seat: 'Ada' },
      );
      expect(sent.status).toBe(201);

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      expect((await listAudit(h.server.store, teamId)).some((r) => r.action === 'ask.raised')).toBe(
        true,
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toHaveLength(0);
      expect(
        (await listAudit(h.server.store, teamId)).some((r) => r.action === 'doorbell.surfaced'),
      ).toBe(false);

      // The agent's re-notify — an in-thread ask — always fires the loud surface, present admin or not:
      // the human's silence despite presence is exactly what earns the escalation.
      const renotify = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            ...env(
              'Ada',
              { kind: 'team' },
              'ask',
              { species: 'escalate', tier: 'blocking' },
              'ask-p2',
            ),
            thread: 'ask-p1',
          },
        },
        { key: team.json.agent_key, seat: 'Ada' },
      );
      expect(renotify.status).toBe(201);
      await pollUntil(async () =>
        (await listAudit(h.server.store, teamId)).some((r) => r.action === 'doorbell.surfaced'),
      );
      expect(calls).toHaveLength(1);
    });

    it('the ADR 153 ceiling guard: presence never moves the tier contract — present and away yield byte-identical clocks', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
      await post(
        '/teams/dawn/policy',
        { ask_slack_webhook: 'https://hooks.slack.test/T/B/x' },
        nickCred,
      );
      stubSlack(() => new Response('ok', { status: 200 }));
      await post('/teams/dawn/presence', { surface: 'web' }, nickCred);

      // Present admin (fresh presence row just attached).
      const present = await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'ask',
            { species: 'escalate', tier: 'blocking' },
            'ask-g1',
          ),
        },
        { key: team.json.agent_key, seat: 'Ada' },
      );
      // Away admin: only escalation-eagerness may change, never the clock.
      await post('/teams/dawn/availability', { status: 'away' }, nickCred);
      const away = await post(
        '/teams/dawn/messages',
        {
          envelope: env(
            'Ada',
            { kind: 'team' },
            'ask',
            { species: 'escalate', tier: 'blocking' },
            'ask-g2',
          ),
        },
        { key: team.json.agent_key, seat: 'Ada' },
      );

      // Byte-for-byte the shipped ADR 147 default in both worlds — a hold whose window moved with
      // presence would be a defect (ADR 153 invariant, ADR 155 guard metric a).
      expect(present.json.ask_contract).toEqual({
        timeout_ms: 15 * 60_000,
        no_answer: 'hold',
        unblocker_reachable: true,
      });
      expect(away.json.ask_contract).toEqual(present.json.ask_contract);
    });
  });

  describe('the doorbell (ADR 443)', async () => {
    function env(
      from: string,
      to: unknown,
      act: string,
      id: string,
      meta: Record<string, unknown> | null = null,
      extra: Record<string, unknown> = {},
    ) {
      return {
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to,
        act,
        body: 'the secret plan',
        meta,
        ts: Date.now(),
        ...extra,
      };
    }
    const consult = { species: 'consult', tier: 'standard' };
    const toDee = { kind: 'member', name: 'Dee' };
    const slackPolicy = { ask_slack_webhook: 'https://hooks.slack.test/T/B/x' };

    async function team() {
      const t = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nick = t.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nick);
      await post('/teams/dawn/members', { name: 'Bob', kind: 'agent' }, nick);
      // A human who is NOT an admin, so "directed rings its human" is apart from "asks ring admins".
      const dee = await post('/teams/dawn/members', { name: 'Dee', kind: 'human' }, nick);
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      return {
        nick,
        dee: dee.json.human_credential as string,
        ada: { key: t.json.agent_key as string, seat: 'Ada' },
        teamId,
      };
    }
    const send = async (auth: Auth, envelope: Record<string, unknown>) =>
      await post('/teams/dawn/messages', { envelope }, auth);
    const rings = async (teamId: string) =>
      Promise.all(
        (await listRings(h.server.store, teamId)).map(async (r) => ({
          member: (await getMemberById(h.server.store, r.member_id))!.name,
          state: r.state,
          act: r.act_id,
        })),
      );
    const surfaced = async (teamId: string) =>
      (await listAudit(h.server.store, teamId)).filter((r) => r.action === 'doorbell.surfaced');
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** Replace the sink transport at its seam; the test server's own fetch is untouched. */
    function stubHooks(onBody?: (raw: unknown) => void) {
      const calls: { url: string; text: string }[] = [];
      setSinkPostForTests(async (url, body) => {
        const raw = JSON.parse(body) as { text: string };
        onBody?.(raw);
        calls.push({ url, text: raw.text });
        return { ok: true, status: 200 };
      });
      return calls;
    }
    afterEach(() => setSinkPostForTests(null));

    it('rings a directed ask or handoff to a human and a team ask to the admin; never a team request_help or a handoff to an agent', async () => {
      const t = await team();
      await send(t.ada, env('Ada', toDee, 'ask', 'd1', consult));
      await send(t.ada, env('Ada', { kind: 'member', name: 'Bob' }, 'handoff', 'd2'));
      await send(t.ada, env('Ada', { kind: 'team' }, 'ask', 'd3', consult));
      await send(t.ada, env('Ada', { kind: 'team' }, 'request_help', 'd4'));
      await send(t.ada, env('Ada', toDee, 'handoff', 'd5'));
      expect((await rings(t.teamId)).map((r) => [r.member, r.act])).toEqual([
        ['Dee', 'd1'],
        ['nick', 'd3'],
        ['Dee', 'd5'],
      ]);
    });

    it('the stored record carries no body', async () => {
      const t = await team();
      await send(t.ada, env('Ada', toDee, 'ask', 'b1', consult));
      const raw = (await h.server.store.all('SELECT record FROM doorbell_rings'))
        .map((r) => r.record)
        .join('\n');
      expect(raw).toContain('"act_id":"b1"');
      expect(raw).not.toMatch(/secret plan/);
    });

    it('holds a standard ask while the human is dnd, and rings it when they set available', async () => {
      const t = await team();
      await post('/teams/dawn/availability', { status: 'dnd' }, t.dee);
      await send(t.ada, env('Ada', toDee, 'ask', 'h1', consult));
      expect((await rings(t.teamId))[0]!.state).toBe('held');
      await post('/teams/dawn/availability', { status: 'available' }, t.dee);
      expect((await rings(t.teamId))[0]!.state).not.toBe('held');
    });

    it('a blocking ask pierces dnd', async () => {
      const t = await team();
      await post('/teams/dawn/availability', { status: 'dnd' }, t.dee);
      await send(t.ada, env('Ada', toDee, 'ask', 'p1', { species: 'approve', tier: 'blocking' }));
      expect((await rings(t.teamId))[0]!.state).not.toBe('held');
    });

    it('off_hours does not hold (no schedule enforcement in v1)', async () => {
      const t = await team();
      await post('/teams/dawn/availability', { status: 'off_hours' }, t.dee);
      await send(t.ada, env('Ada', toDee, 'ask', 'o1', consult));
      expect((await rings(t.teamId))[0]!.state).not.toBe('held');
    });

    it('a held ring whose act was answered meanwhile is dropped, not rung', async () => {
      const t = await team();
      await post('/teams/dawn/policy', slackPolicy, t.nick);
      const calls = stubHooks();
      await post('/teams/dawn/availability', { status: 'away' }, t.dee);
      await send(t.ada, env('Ada', toDee, 'ask', 'a1', consult));
      await send(
        t.dee,
        env('Dee', { kind: 'member', name: 'Ada' }, 'accept', 'a2', { in_reply_to: 'a1' }),
      );
      await post('/teams/dawn/availability', { status: 'available' }, t.dee);
      expect((await rings(t.teamId)).find((r) => r.act === 'a1')!.state).toBe('done');
      await tick(50);
      expect(calls).toHaveLength(0);
      expect(await surfaced(t.teamId)).toHaveLength(0);
    });

    it('a held ring whose thread was resolved meanwhile is dropped, not rung', async () => {
      const t = await team();
      await post('/teams/dawn/policy', slackPolicy, t.nick);
      const calls = stubHooks();
      await post('/teams/dawn/availability', { status: 'away' }, t.dee);
      await send(t.ada, env('Ada', toDee, 'ask', 'r1', consult));
      await send(t.ada, env('Ada', toDee, 'resolve', 'r2', null, { thread: 'r1' }));
      await post('/teams/dawn/availability', { status: 'available' }, t.dee);
      expect((await rings(t.teamId)).find((r) => r.act === 'r1')!.state).toBe('done');
      await tick(50);
      expect(calls).toHaveLength(0);
    });

    it('a held ring rings Slack when released, with the ask body read at dispatch', async () => {
      const t = await team();
      await post('/teams/dawn/policy', slackPolicy, t.nick);
      const calls = stubHooks();
      await post('/teams/dawn/availability', { status: 'away' }, t.dee);
      await send(t.ada, env('Ada', toDee, 'ask', 's1', consult));
      await tick(30);
      expect(calls).toHaveLength(0);
      await post('/teams/dawn/availability', { status: 'available' }, t.dee);
      await pollUntil(async () => (await surfaced(t.teamId)).length === 1);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.text).toContain('the secret plan');
      expect((await surfaced(t.teamId))[0]!.detail).not.toContain('hooks.slack.test');
    });

    it('a hold that lapses by its until is flushed on the sweep, with no availability POST', async () => {
      const t = await team();
      // A generous until, then move the deadline — a real 40 ms window loses the race under coverage.
      await post('/teams/dawn/availability', { status: 'away', until: Date.now() + 5_000 }, t.dee);
      await send(t.ada, env('Ada', toDee, 'ask', 'u1', consult));
      expect((await rings(t.teamId))[0]!.state).toBe('held');
      const ctx = {
        db: h.server.store,
        config: { presenceTimeoutMs: 45_000 },
      } as unknown as Ctx;
      await flushLapsedHolds(ctx, async (id) => await getTeamById(h.server.store, id));
      expect((await rings(t.teamId))[0]!.state).toBe('held'); // not lapsed yet
      await h.server.store.run(
        "UPDATE members SET availability = ? WHERE team_id = ? AND name = 'Dee'",
        [JSON.stringify({ status: 'away', until: Date.now() - 1 }), t.teamId],
      );
      await flushLapsedHolds(ctx, async (id) => await getTeamById(h.server.store, id));
      expect((await rings(t.teamId))[0]!.state).not.toBe('held');
    });

    it('a held ring for a member who left is closed on the sweep, not rung', async () => {
      const t = await team();
      await post('/teams/dawn/availability', { status: 'away', until: Date.now() + 5_000 }, t.dee);
      await send(t.ada, env('Ada', toDee, 'ask', 'l1', consult));
      expect((await rings(t.teamId))[0]!.state).toBe('held');
      await h.server.store.run(
        "UPDATE members SET left_at = ? WHERE team_id = ? AND name = 'Dee'",
        [Date.now(), t.teamId],
      );
      const ctx = {
        db: h.server.store,
        config: { presenceTimeoutMs: 45_000 },
      } as unknown as Ctx;
      await flushLapsedHolds(ctx, async (id) => await getTeamById(h.server.store, id));
      expect((await rings(t.teamId))[0]!.state).toBe('done');
      expect(await surfaced(t.teamId)).toHaveLength(0);
    });

    it('prunes done and queued rings past retention, and keeps held ones', async () => {
      const t = await team();
      const dee = (await getMemberByName(h.server.store, t.teamId, 'Dee'))!;
      const old = Date.now() - DOORBELL_RING_RETENTION_MS - 1;
      const record = {
        team: 'dawn',
        from: 'Ada',
        act: 'handoff',
        act_id: 'x',
        answer_path: '/live?act=x',
      } as const;
      for (const state of ['done', 'queued', 'held'] as const) {
        await insertRing(h.server.store, {
          team_id: t.teamId,
          member_id: dee.id,
          act_id: 'x',
          record,
          sinks: ['live'],
          state,
          host: null,
          created_at: old,
        });
      }
      await insertRing(h.server.store, {
        team_id: t.teamId,
        member_id: dee.id,
        act_id: 'y',
        record,
        sinks: ['live'],
        state: 'done',
        host: null,
      });
      expect(await pruneRings(h.server.store, Date.now())).toBe(2);
      expect(await (await rings(t.teamId)).map((r) => r.state).sort()).toEqual(['done', 'held']);
    });

    it('a Slack handoff ring names who and what, never the body', async () => {
      const t = await team();
      await post('/teams/dawn/policy', slackPolicy, t.nick);
      const calls = stubHooks();
      await post('/teams/dawn/availability', { status: 'off_hours' }, t.dee);
      await send(t.ada, env('Ada', toDee, 'handoff', 'f1'));
      await pollUntil(async () => (await surfaced(t.teamId)).length === 1);
      expect(calls[0]!.text).toContain('[dawn] Ada handed you work');
      expect(calls[0]!.text).toContain('/live?act=f1');
      expect(calls[0]!.text).not.toContain('secret plan');
    });

    it('a team Slack URL shared by several rung admins posts once per act', async () => {
      const t = await team();
      const ana = await post('/teams/dawn/members', { name: 'Ana', kind: 'human' }, t.nick);
      const anaRow = (await getMemberByName(h.server.store, t.teamId, 'Ana'))!;
      await setMemberGovernance(
        h.server.store,
        anaRow.id,
        null,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      );
      await post('/teams/dawn/policy', slackPolicy, t.nick);
      await post('/teams/dawn/availability', { status: 'off_hours' }, t.nick);
      await post('/teams/dawn/availability', { status: 'off_hours' }, ana.json.human_credential);
      const calls = stubHooks();
      await send(t.ada, env('Ada', { kind: 'team' }, 'ask', 'm1', consult));
      await pollUntil(async () => (await surfaced(t.teamId)).length === 1);
      await tick(30);
      expect(await (await rings(t.teamId)).map((r) => r.member).sort()).toEqual(['Ana', 'nick']);
      expect(calls).toHaveLength(1);
    });

    it('a personal webhook gets the record as JSON, with no body key', async () => {
      const t = await team();
      const dee = (await getMemberByName(h.server.store, t.teamId, 'Dee'))!;
      await setDoorbellPrefs(h.server.store, dee.id, {
        sinks: { webhook: { on: true, url: 'https://hooks.slack.test/personal' } },
      });
      const bodies: unknown[] = [];
      stubHooks((raw) => bodies.push(raw));
      await post('/teams/dawn/availability', { status: 'off_hours' }, t.dee);
      await send(t.ada, env('Ada', toDee, 'ask', 'w1', consult));
      await pollUntil(async () => (await surfaced(t.teamId)).length === 1);
      expect(bodies[0]).toMatchObject({ team: 'dawn', from: 'Ada', act: 'ask', act_id: 'w1' });
      expect(bodies[0]).not.toHaveProperty('body');
      expect(JSON.parse((await surfaced(t.teamId))[0]!.detail!)).toMatchObject({
        surface: 'webhook',
        ok: true,
      });
    });

    it('a dead sink endpoint cannot slow the send: 201 while the sink call is still in flight, one ok:false row, no retry', async () => {
      const t = await team();
      await post('/teams/dawn/policy', slackPolicy, t.nick);
      let attempts = 0;
      // The sink call hangs until the test lets it fail. A send that awaited the sink could not
      // return while this gate is shut, so there is no clock and no budget to tune: this was a
      // wall-clock bound (250 ms sqlite / 1500 ms PGlite against a 300 ms sink) that CI load alone
      // tripped — 416 ms and 1700 ms on a busy runner, 2026-10-02 — at ~25 min a red.
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      setSinkPostForTests(async () => {
        attempts++;
        await gate;
        return { ok: false };
      });
      await post('/teams/dawn/availability', { status: 'off_hours' }, t.dee);
      const sent = await send(t.ada, env('Ada', toDee, 'ask', 'x1', consult));
      expect(sent.status).toBe(201);
      // The send is back. The sink was reached (detached from it) and is still hanging, so its
      // failure has not been recorded yet.
      await pollUntil(() => attempts === 1, 2000);
      expect(await surfaced(t.teamId)).toHaveLength(0);
      openGate();
      await pollUntil(async () => (await surfaced(t.teamId)).length === 1, 2000);
      expect(JSON.parse((await surfaced(t.teamId))[0]!.detail!)).toMatchObject({
        surface: 'slack',
        ok: false,
      });
      await tick(50);
      expect(attempts).toBe(1);
    });

    // ── prefs, privacy and URL checks (ADR 443 §5) ──

    const put = async (path: string, body: unknown, auth: Auth) =>
      await req('PUT', path, body, auth);
    const personal = { sinks: { webhook: { on: true, url: 'https://ntfy.sh/dee-secret-topic' } } };

    it('a human sets and reads back their own prefs, personal URL included', async () => {
      const t = await team();
      const set = await put('/teams/dawn/members/me/doorbell', personal, t.dee);
      expect(set.status).toBe(200);
      const got = await get('/teams/dawn/members/me/doorbell', t.dee);
      expect(got.json.prefs.sinks.webhook.url).toBe('https://ntfy.sh/dee-secret-topic');
      expect(got.json.route).toEqual(['live', 'os', 'webhook']);
      expect(got.json.team_urls).toEqual({ slack: false, webhook: false });
    });

    it('an admin sees that a personal sink exists and is on, never its URL', async () => {
      const t = await team();
      await put('/teams/dawn/members/me/doorbell', personal, t.dee);
      const got = await get('/teams/dawn/members/Dee/doorbell', t.nick);
      expect(got.status).toBe(200);
      expect(got.json.sinks).toEqual({ webhook: { on: true, personal: true } });
      expect(JSON.stringify(got.json)).not.toMatch(/ntfy|secret|"url"/);
    });

    it('a non-admin cannot read another member’s doorbell', async () => {
      const t = await team();
      const got = await get('/teams/dawn/members/nick/doorbell', t.dee);
      expect(got.status).toBe(403);
    });

    it('an agent has no doorbell', async () => {
      const t = await team();
      const got = await get('/teams/dawn/members/me/doorbell', t.ada);
      expect(got.status).toBe(403);
      expect(got.json.error.message).toMatch(/for human members/);
    });

    it('a sink outside the team allow-list is refused 422, naming the sink', async () => {
      const t = await team();
      await post('/teams/dawn/policy', { doorbell: { allow: ['live', 'os'] } }, t.nick);
      const set = await put('/teams/dawn/members/me/doorbell', personal, t.dee);
      expect(set.status).toBe(422);
      expect(set.json.error.message).toBe('the webhook sink is not allowed on this team');
    });

    it.each([
      'http://ntfy.sh/topic',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest',
      'https://10.1.2.3/x',
      'https://172.20.0.1/x',
      'https://192.168.0.9/x',
      'https://[fd12::1]/x',
    ])('a personal URL %s is refused 422 without echoing it', async (url) => {
      const t = await team();
      const set = await put(
        '/teams/dawn/members/me/doorbell',
        { sinks: { webhook: { on: true, url } } },
        t.dee,
      );
      expect(set.status).toBe(422);
      expect(set.json.error.message).toMatch(/^the webhook url must/);
      expect(JSON.stringify(set.json)).not.toContain(url);
    });

    it.each([
      { doorbell: { webhook_url: 'https://10.0.0.1/hook' } },
      { doorbell: { slack_url: 'http://hooks.slack.com/x' } },
      { ask_slack_webhook: 'https://192.168.1.1/x' },
    ])('a team policy with a non-public sink URL is refused 422', async (policy) => {
      const t = await team();
      const set = await post('/teams/dawn/policy', policy, t.nick);
      expect(set.status).toBe(422);
      expect(set.json.error.message).toMatch(/^the team (slack|webhook) url must/);
    });

    it('ask_slack_webhook reads through as the team slack sink, and the stored blob is not rewritten', async () => {
      const t = await team();
      await post('/teams/dawn/policy', slackPolicy, t.nick);
      const got = await get('/teams/dawn/members/me/doorbell', t.dee);
      expect(got.json.defaults).toEqual(['live', 'os', 'slack']);
      expect(got.json.team_urls).toEqual({ slack: true, webhook: false });
      expect(JSON.stringify(got.json)).not.toContain('hooks.slack.test');
      const stored = await get('/teams/dawn/policy', t.nick);
      expect(stored.json.stored).toEqual(slackPolicy);
    });

    // ── the `os` sink: the host claims and raises (ADR 443 §3) ──

    async function osTeam() {
      const t = await team();
      const created = teamBootstraps.get('dawn')!;
      await put(
        '/teams/dawn/members/me/doorbell',
        { sinks: { os: { on: true, host: 'mac-a' } } },
        t.dee,
      );
      return { ...t, key: created.agentKey };
    }
    const claim = async (key: string, host: string) =>
      await post('/teams/dawn/doorbell/rings', { host }, key);

    it('a ring is handed to the host enrolled under its label, and to no other', async () => {
      const t = await osTeam();
      await send(t.ada, env('Ada', toDee, 'ask', 'os1', consult));
      expect((await rings(t.teamId))[0]!.state).toBe('queued');
      const other = await claim(t.key, 'mac-b');
      expect(other.json.rings).toEqual([]);
      const mine = await claim(t.key, 'mac-a');
      expect(mine.status).toBe(200);
      expect(mine.json.rings).toHaveLength(1);
      expect(mine.json.rings[0]).toMatchObject({
        member: 'Dee',
        record: { team: 'dawn', from: 'Ada', act: 'ask', act_id: 'os1' },
      });
      expect(JSON.stringify(mine.json)).not.toContain('secret plan');
    });

    it('a second claim raises nothing twice', async () => {
      const t = await osTeam();
      await send(t.ada, env('Ada', toDee, 'handoff', 'os2'));
      expect((await claim(t.key, 'mac-a')).json.rings).toHaveLength(1);
      expect((await claim(t.key, 'mac-a')).json.rings).toEqual([]);
      expect((await rings(t.teamId))[0]!.state).toBe('done');
    });

    it('a ring answered meanwhile, or too old to matter, is claimed without a banner', async () => {
      const t = await osTeam();
      await send(t.ada, env('Ada', toDee, 'ask', 'os3', consult));
      await send(
        t.dee,
        env('Dee', { kind: 'member', name: 'Ada' }, 'accept', 'os4', { in_reply_to: 'os3' }),
      );
      await send(t.ada, env('Ada', toDee, 'handoff', 'os5'));
      await h.server.store.run("UPDATE doorbell_rings SET created_at = 0 WHERE act_id = 'os5'");
      expect((await claim(t.key, 'mac-a')).json.rings).toEqual([]);
      expect((await rings(t.teamId)).every((r) => r.state === 'done')).toBe(true);
    });

    it('the host reports a banner as doorbell.surfaced {surface: os}; another host cannot', async () => {
      const t = await osTeam();
      await send(t.ada, env('Ada', toDee, 'ask', 'os6', consult));
      const [ring] = (await claim(t.key, 'mac-a')).json.rings;
      const wrong = await post(
        `/teams/dawn/doorbell/rings/${ring.id}/surfaced`,
        { host: 'mac-b', ok: true },
        t.key,
      );
      expect(wrong.status).toBe(404);
      const ok = await post(
        `/teams/dawn/doorbell/rings/${ring.id}/surfaced`,
        { host: 'mac-a', ok: true },
        t.key,
      );
      expect(ok.status).toBe(200);
      expect((await surfaced(t.teamId)).map((r) => JSON.parse(r.detail!))).toEqual([
        { surface: 'os', ok: true },
      ]);
    });

    it('a second report, or a report for a ring never returned, is 409; a bad escape is 400', async () => {
      const t = await osTeam();
      await send(t.ada, env('Ada', toDee, 'ask', 'os7', consult));
      await send(t.ada, env('Ada', toDee, 'handoff', 'os8'));
      await h.server.store.run("UPDATE doorbell_rings SET created_at = 0 WHERE act_id = 'os8'");
      const [ring] = (await claim(t.key, 'mac-a')).json.rings;
      const stale = (await listRings(h.server.store, t.teamId)).find((r) => r.act_id === 'os8')!;
      const report = async (id: string) =>
        await post(`/teams/dawn/doorbell/rings/${id}/surfaced`, { host: 'mac-a', ok: true }, t.key);
      expect((await report(ring.id)).status).toBe(200);
      expect((await report(ring.id)).status).toBe(409);
      expect((await report(stale.id)).status).toBe(409);
      expect((await report('%E0%A4%A')).status).toBe(400);
      expect(await surfaced(t.teamId)).toHaveLength(1);
    });

    it('the ring poll refuses a caller without the team agent key', async () => {
      const t = await osTeam();
      expect((await claim(t.dee, 'mac-a')).status).toBe(401);
    });
  });
});
