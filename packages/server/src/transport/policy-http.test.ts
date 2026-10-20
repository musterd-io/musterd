import { GENERALIST_CAPABILITIES, makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getMemberByName, setMemberGovernance } from '../store/members.js';
import { getTeamBySlug, setPolicy } from '../store/teams.js';
import { claimAgentHttp } from './test-auth.js';

withDrivers('policy-http', (_o, kind) => {
  /**
   * The ADR 185 round-trip. Storing sparsely in `setPolicy` is not enough on its own: `GET /policy`
   * used to return only the defaults-applied policy, the CLI merged its flags into *that*, and the very
   * next write re-froze every default into the row. These assertions pin the wire shape that makes the
   * read-merge-write loop keep a row sparse across repeated writes.
   */
  let server: RunningServer;
  let base: string;
  let nickCred: string;
  let agentKey: string;

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

  const storedRow = async (): Promise<unknown> => {
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    const row = await server.store.get('SELECT policy FROM teams WHERE id = ?', [team.id]);
    return row?.policy ? JSON.parse(row.policy) : null;
  };

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    nickCred = team.json.human_credential;
    agentKey = team.json.agent_key;
  });

  afterEach(async () => {
    await server.close();
  });

  describe('GET /policy returns both halves (ADR 185)', () => {
    it('an untouched team: everything effective, nothing stored', async () => {
      const r = await get('/teams/dawn/policy', bearer(nickCred));
      expect(r.status).toBe(200);
      expect(r.json.stored).toEqual({});
      expect(r.json.policy.residency.hourly_cap).toBe(2); // the shipped default, unfrozen
    });

    it('after one write, `stored` names exactly the chosen knob', async () => {
      await post('/teams/dawn/policy', { standing_reseat_known_agents: true }, bearer(nickCred));
      const r = await get('/teams/dawn/policy', bearer(nickCred));
      // ADR 533: the one knob, plus the review date the daemon stamps on any doc that holds one.
      expect(r.json.stored).toEqual({
        standing_reseat_known_agents: true,
        review_by: expect.any(Number),
      });
      expect(r.json.policy.standing_reseat_known_agents).toBe(true);
      expect(r.json.policy.residency.transcript_max_bytes).toBe(262_144);
    });
  });

  describe('the read-merge-write loop keeps the row sparse', () => {
    it('three successive one-knob writes leave three keys, not the whole schema', async () => {
      // Exactly what the CLI does — and the loop that used to re-materialize every default each time.
      for (const knob of [
        { standing_reseat_known_agents: true },
        { ask_fallback_to_nonadmin: true },
        { residency: { hourly_cap: 5 } },
      ]) {
        const { json } = await get('/teams/dawn/policy', bearer(nickCred));
        await post('/teams/dawn/policy', { ...json.stored, ...knob }, bearer(nickCred));
      }
      expect(await storedRow()).toEqual({
        standing_reseat_known_agents: true,
        ask_fallback_to_nonadmin: true,
        residency: { hourly_cap: 5 },
        review_by: expect.any(Number),
      });
    });

    it('omitting a key unsets it — the webhook `off` path restores the real default', async () => {
      await post(
        '/teams/dawn/policy',
        { ask_slack_webhook: 'https://hooks.slack.test/x', residency: { hourly_cap: 5 } },
        bearer(nickCred),
      );
      const { json } = await get('/teams/dawn/policy', bearer(nickCred));
      const { ask_slack_webhook: _dropped, ...rest } = json.stored;
      await post('/teams/dawn/policy', rest, bearer(nickCred));

      expect(await storedRow()).toEqual({
        residency: { hourly_cap: 5 },
        review_by: expect.any(Number),
      });
      const after = await get('/teams/dawn/policy', bearer(nickCred));
      expect(after.json.policy.ask_slack_webhook).toBeUndefined();
    });
  });

  describe('the policy.change audit records the request, not the parsed result', () => {
    it('keeps policy credentials on the hub and redacts them from the audit event', async () => {
      const secrets = {
        ask_slack_webhook: 'https://hooks.slack.test/ASK_SENTINEL',
        seeds_relay_url: 'https://relay.test/SEEDS_URL_SENTINEL',
        seeds_relay_token: 'SEEDS_TOKEN_SENTINEL',
        away_relay_url: 'wss://relay.test/AWAY_URL_SENTINEL',
        away_relay_token: 'AWAY_TOKEN_SENTINEL',
        slack_bot_token: 'SLACK_TOKEN_SENTINEL',
        doorbell: {
          slack_url: 'https://hooks.slack.test/DOORBELL_SLACK_SENTINEL',
          webhook_url: 'https://hooks.test/DOORBELL_WEBHOOK_SENTINEL',
        },
      };
      const set = await post(
        '/teams/dawn/policy',
        { ...secrets, ask_fallback_to_nonadmin: true },
        bearer(nickCred),
      );
      expect(set.status).toBe(200);
      expect(await storedRow()).toMatchObject({ ...secrets, ask_fallback_to_nonadmin: true });

      const audit = await server.store.get<{ detail: string }>(
        "SELECT detail FROM audit WHERE action = 'policy.change' ORDER BY ts DESC LIMIT 1",
      );
      expect(audit).toBeDefined();
      const marker = { $redacted: 'policy-secret' };
      expect(JSON.parse(audit!.detail)).toMatchObject({
        ask_slack_webhook: marker,
        seeds_relay_url: marker,
        seeds_relay_token: marker,
        away_relay_url: marker,
        away_relay_token: marker,
        slack_bot_token: marker,
        doorbell: { slack_url: marker, webhook_url: marker },
        ask_fallback_to_nonadmin: true,
      });
      const encoded = audit!.detail;
      for (const value of [
        ...Object.values(secrets).filter((value): value is string => typeof value === 'string'),
        ...Object.values(secrets.doorbell),
      ])
        expect(encoded).not.toContain(value);
    });

    it('ADR 533: a write stamps review_by on the stored doc; a client-supplied policy_review marker is stripped', async () => {
      const before = Date.now();
      const set = await post(
        '/teams/dawn/policy',
        { ask_fallback_to_nonadmin: true },
        bearer(nickCred),
      );
      expect(set.status).toBe(200);
      expect(set.json.stored.review_by).toBeGreaterThanOrEqual(before + 89 * 86_400_000);
      expect(set.json.policy).not.toHaveProperty('review_by');
      const past = await post(
        '/teams/dawn/policy',
        { ask_fallback_to_nonadmin: true, review_by: before - 1 },
        bearer(nickCred),
      );
      expect(past.status).toBe(422);
      const forgedId = ulid();
      const forged = await post(
        '/teams/dawn/messages',
        {
          envelope: makeEnvelope({
            id: forgedId,
            team: 'dawn',
            from: 'nick',
            to: { kind: 'team' },
            act: 'ask',
            body: 'forged',
            meta: {
              species: 'approve',
              tier: 'standard',
              policy_review: { review_by: 1, keys: [] },
            },
            ts: Date.now(),
          }),
        },
        bearer(nickCred),
      );
      expect(forged.status).toBeLessThan(300);
      const row = await server.store.get<{ meta: string }>(
        'SELECT meta FROM messages WHERE id = ?',
        [forgedId],
      );
      expect(JSON.parse(row!.meta)).not.toHaveProperty('policy_review');
    });

    it('ADR 533 end to end: the sweep asks the Team once as `policy`; a human admin accept re-confirms over the wire', async () => {
      const team = (await getTeamBySlug(server.store, 'dawn'))!;
      const past = Date.now() - 86_400_000;
      await setPolicy(server.store, team.id, { ask_fallback_to_nonadmin: true, review_by: past });
      expect(await server.runPolicyReviewSweep()).toBe(1);
      expect(await server.runPolicyReviewSweep()).toBe(0);
      const inbox = await get('/teams/dawn/inbox?unread_only=0', bearer(nickCred));
      const ask = (inbox.json.messages as any[]).find((m) => m.meta?.policy_review);
      expect(ask).toMatchObject({
        from: 'policy',
        act: 'ask',
        meta: { species: 'approve', tier: 'standard', policy_review: { review_by: past } },
      });
      const before = Date.now();
      const answer = await post(
        '/teams/dawn/messages',
        {
          envelope: makeEnvelope({
            id: ulid(),
            team: 'dawn',
            from: 'nick',
            to: { kind: 'team' },
            act: 'accept',
            body: 'keep it',
            meta: { in_reply_to: ask.id },
            ts: Date.now(),
          }),
        },
        bearer(nickCred),
      );
      expect(answer.status).toBeLessThan(300);
      const after = await get('/teams/dawn/policy', bearer(nickCred));
      expect(after.json.stored.ask_fallback_to_nonadmin).toBe(true);
      expect(after.json.stored.review_by).toBeGreaterThanOrEqual(before + 89 * 86_400_000);
      // The announcement is nick's own act, so it is not in nick's inbox — read the record.
      const note = await server.store.get<{ body: string; from_member: string }>(
        "SELECT body, from_member FROM messages WHERE meta LIKE '%policy_review_answer%'",
      );
      expect(note!.body).toContain('re-confirmed by nick');
      const audit = (await listAudit(server.store, team.id)).filter(
        (r) => r.action === 'policy.review_answered',
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor).toBe('nick');
    });

    it('one chosen knob ⇒ a one-key audit detail (intent is recoverable going forward)', async () => {
      await post('/teams/dawn/policy', { residency: { cooldown_ms: 60_000 } }, bearer(nickCred));
      const team = (await getTeamBySlug(server.store, 'dawn'))!;
      const rows = (await listAudit(server.store, team.id)).filter(
        (r) => r.action === 'policy.change',
      );
      expect(rows).toHaveLength(1);
      // The old row wrote the post-parse policy here, which is why nothing could later say whether a
      // stored value had been chosen or baked in.
      expect(JSON.parse(rows[0]!.detail as string)).toEqual({
        residency: { cooldown_ms: 60_000 },
        review_by: expect.any(Number),
      });
    });
  });

  describe('admins are human-only at the read, not just at reconcile (ADR 172)', () => {
    /** Mint `stale` of `kind`, then give its row the shape reconcile no longer writes but an older row
     *  can still hold. Returns the headers that authenticate as it. */
    async function staleAdmin(memberKind: 'agent' | 'service'): Promise<Record<string, string>> {
      const minted = await post(
        '/teams/dawn/members',
        { name: 'stale', kind: memberKind, role: '' },
        bearer(nickCred),
      );
      const team = (await getTeamBySlug(server.store, 'dawn'))!;
      const row = (await getMemberByName(server.store, team.id, 'stale'))!;
      await setMemberGovernance(
        server.store,
        row.id,
        null,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      );
      if (memberKind === 'service') return bearer(minted.json.token as string);
      const auth = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'stale');
      return {
        ...bearer(auth.key),
        'x-musterd-session-lease': auth.sessionLease,
        'x-musterd-seat': 'stale',
      };
    }

    it.each(['agent', 'service'] as const)(
      'a stale %s row whose capabilities JSON still carries is_admin cannot read or set policy',
      async (memberKind) => {
        const headers = await staleAdmin(memberKind);
        expect((await get('/teams/dawn/policy', headers)).status).toBe(403);
        const write = await post('/teams/dawn/policy', { residency: { hourly_cap: 99 } }, headers);
        expect(write.status).toBe(403);
        expect(await storedRow()).toBeNull();
      },
    );

    it('the human creator stays admin', async () => {
      expect((await get('/teams/dawn/policy', bearer(nickCred))).status).toBe(200);
    });
  });

  describe('GET /guardian-tiers — the scoped member read (ADR 263 follow-up)', () => {
    it('a service seat reads the tier map without admin visibility; the webhook never rides along', async () => {
      await post(
        '/teams/dawn/policy',
        {
          guardian_tiers: { daemon_down: 'auto' },
          ask_slack_webhook: 'https://hooks.example.com/s',
        },
        bearer(nickCred),
      );
      const minted = await post(
        '/teams/dawn/members',
        { name: 'guardian', kind: 'service', role: 'platform' },
        bearer(nickCred),
      );
      const token = minted.json.token as string;

      // The full policy stays admin-only for this seat…
      expect((await get('/teams/dawn/policy', bearer(token))).status).toBe(403);
      // …but the scoped read answers, tiers only (the /enforcement precedent).
      const tiers = await get('/teams/dawn/guardian-tiers', bearer(token));
      expect(tiers.status).toBe(200);
      expect(tiers.json).toEqual({ guardian_tiers: { daemon_down: 'auto' } });
    });

    it('an untouched team answers the empty map, not an error', async () => {
      const tiers = await get('/teams/dawn/guardian-tiers', bearer(nickCred));
      expect(tiers.status).toBe(200);
      expect(tiers.json).toEqual({ guardian_tiers: {} });
    });
  });
});
