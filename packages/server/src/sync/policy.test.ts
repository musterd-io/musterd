import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { answerPolicyReview, raisePolicyReview } from '../store/policyReview.js';
import { getPolicy, getStoredPolicy, getTeamBySlug, setPolicy } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { joinerEnrollment } from './claim.js';
import { foldBatch } from './fold.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('policy', (_o, kind) => {
  /**
   * Policy replication (ADR 367, residence-2 census gap 1) between two real daemons.
   *
   * The census measured the gap: `setPolicy` wrote a local blob and nothing shipped it, so a joiner's
   * host actuator ran different `hourly_cap`/`cooldown`/`loops` than the hub after every `policy set`
   * — the one policy input to the wake ledger, forked silently per machine. These are the lane's
   * falsifiers: hub changes reach the joiner, while joiner policy writes and review answers fail
   * hub-local before changing state or sending policy values.
   *
   * Harness copied from census.test.ts so this file stands alone.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickOnHub: string;
  let nickOnJoiner: string;
  let dir: string;
  let joinerCtx: Ctx;

  async function post(base: string, path: string, body?: unknown, auth?: string) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
  }

  const hubCtx = (): Ctx => ({
    db: hub.store,
    hub: new Hub(),
    config: resolveConfig(),
    rosterRoots: [],
  });
  const hubTeam = async () => (await getTeamBySlug(hub.store, 'bravo'))!;
  const joinerTeam = async () => (await getTeamBySlug(joiner.store, 'bravo'))!;

  async function roundTrip() {
    await pushTeam(joinerCtx, await joinerTeam());
    await pullTeam(hubCtx(), await hubTeam());
    await pushTeam(hubCtx(), await hubTeam());
    await pullTeam(joinerCtx, await joinerTeam());
  }

  async function enrollJoiner() {
    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'joiner laptop' },
      nickOnHub,
    );
    const res = await post(joinerBase, '/node/enroll', {
      hub_url: hubBase,
      code: minted.invite,
      team: 'bravo',
    });
    expect(res.status).toBe(200);
  }

  /**
   * A SECOND enrolled node — a real machine credential for this team, held by neither the hub nor the
   * first joiner. This is the attacker's actual position in gptbot's review of #1228: not an outsider
   * guessing a token, but an admitted machine (an agent's laptop, a CI box, a node whose human is an
   * ordinary member) doing something its enrollment never entitled it to.
   *
   * It needs no daemon of its own, which is why it can live in this file: `/nodes/join` is the hub's
   * half of enrollment and hands back the credential directly. Standing up a second `RunningServer`
   * would not work here anyway — `MUSTERD_NODE_STATE` is one file keyed by slug, so a second daemon
   * enrolling as `bravo` overwrites the first joiner's entry and breaks `roundTrip`.
   */
  async function enrollSecondNode(label: string): Promise<{ credential: string; nodeId: string }> {
    const { json: minted } = await post(hubBase, '/teams/bravo/nodes/invite', { label }, nickOnHub);
    const nodeId = `node-${label.replace(/\W+/g, '-')}`;
    const { status, json } = await post(hubBase, '/teams/bravo/nodes/join', {
      code: minted.invite,
      node_id: nodeId,
      label,
    });
    expect(status).toBe(200);
    return { credential: json.node_credential, nodeId: json.node_id };
  }

  /**
   * Make nick resident on the joiner as far as the HUB is concerned — one ordinary act, replicated.
   * A resident seat is needed for the other hub-authoritative writes covered by this fixture;
   * policy writes themselves now remain hub-local under ADR 729.
   */
  async function residentOnJoiner() {
    const opened = await post(
      joinerBase,
      '/teams/bravo/lanes',
      { title: 'nick works from this laptop', claim: true },
      nickOnJoiner,
    );
    expect(opened.status).toBe(201);
    await roundTrip();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-policy-sync-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
    hub = createServer({ db: await openTestDriver(kind), port: 0, syncLoops: false });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({
      db: await openTestDriver(kind, { instance: 'b' }),
      port: 0,
      syncLoops: false,
    });
    joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
    joinerCtx = {
      db: joiner.store,
      hub: new Hub(),
      config: resolveConfig(),
      rosterRoots: [],
    };
    nickOnHub = (
      await post(hubBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    nickOnJoiner = (
      await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    // The joiner's node row is minted on its first logged act, and enrollment needs one.
    const jt = await joinerTeam();
    await insertMessage(
      joiner.store,
      jt.id,
      (await getMemberByName(joiner.store, jt.id, 'nick'))!.id,
      null,
      makeEnvelope({
        id: 'j-0',
        team: 'bravo',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: 'hi',
        ts: 1000,
      }),
    );
    await enrollJoiner();
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe('policy replication (ADR 367)', () => {
    it('a hub whose policy was written before the kind existed restates it once a joiner is enrolled (ADR 398)', async () => {
      // The live pair's hole: loops were armed on the hub via an unstamped write (pre-ADR-367, or
      // silent `setPolicy`), so the joiner's `teams.policy` stayed null and every wake derived as a
      // 5-minute reply doorbell. A stamped `policy.change` would already have crossed; this is the
      // case with none.
      await setPolicy(hub.store, (await hubTeam()).id, {
        loops: { dispatch: true, review: true, sweep: true },
      });
      expect(
        await hub.store.get(
          "SELECT COUNT(*) AS n FROM audit WHERE action = 'policy.change' AND origin_seq > 0",
        ),
      ).toEqual({ n: 0 });
      expect((await getPolicy(joiner.store, (await joinerTeam()).id)).loops.dispatch).toBe(false);

      await roundTrip();

      expect((await getPolicy(joiner.store, (await joinerTeam()).id)).loops.dispatch).toBe(true);
      expect(await getStoredPolicy(joiner.store, (await joinerTeam()).id)).toEqual({
        loops: { dispatch: true, review: true, sweep: true },
        review_by: expect.any(Number),
      });
    });

    it('the hub sets a wake cap and the joiner runs it after one round trip', async () => {
      const set = await post(
        hubBase,
        '/teams/bravo/policy',
        { residency: { hourly_cap: 1 } },
        nickOnHub,
      );
      expect(set.status).toBe(200);
      expect(
        (await getPolicy(joiner.store, (await joinerTeam()).id)).residency.hourly_cap,
      ).not.toBe(1);

      await roundTrip();

      // The census's measured gap, now closed: the joiner's host caps wakes by the HUB's number.
      expect((await getPolicy(joiner.store, (await joinerTeam()).id)).residency.hourly_cap).toBe(1);
    });

    it('the folded row is the SPARSE doc — a knob nobody chose keeps this build’s default alive', async () => {
      await post(hubBase, '/teams/bravo/policy', { residency: { hourly_cap: 1 } }, nickOnHub);
      await roundTrip();
      // ADR 185's whole point, carried across the wire: only the chosen key is stored. Shipping the
      // effective policy would bake the hub build's defaults into this row and kill the schema
      // default here for every other knob — the #530 failure, replicated.
      expect(await getStoredPolicy(joiner.store, (await joinerTeam()).id)).toEqual({
        residency: { hourly_cap: 1 },
        review_by: expect.any(Number),
      });
    });

    it('the hub keeps credentials locally and the replica omits redacted policy fields', async () => {
      const secrets = {
        ask_slack_webhook: 'https://hooks.slack.test/ASK_SENTINEL',
        seeds_relay_url: 'https://relay.test/SEEDS_URL_SENTINEL',
        seeds_relay_token: 'SEEDS_TOKEN_SENTINEL',
        away_relay_url: 'wss://relay.test/AWAY_URL_SENTINEL',
        away_relay_token: 'AWAY_TOKEN_SENTINEL',
        slack_bot_token: 'SLACK_TOKEN_SENTINEL',
        doorbell: {
          allow: ['slack'],
          defaults: ['slack'],
          slack_url: 'https://hooks.slack.test/DOORBELL_SLACK_SENTINEL',
          webhook_url: 'https://hooks.test/DOORBELL_WEBHOOK_SENTINEL',
        },
      };
      const set = await post(
        hubBase,
        '/teams/bravo/policy',
        { ...secrets, ask_fallback_to_nonadmin: true },
        nickOnHub,
      );
      expect(set.status).toBe(200);
      expect(await getStoredPolicy(hub.store, (await hubTeam()).id)).toMatchObject({
        ...secrets,
        ask_fallback_to_nonadmin: true,
      });

      await roundTrip();

      const projected = await getStoredPolicy(joiner.store, (await joinerTeam()).id);
      const received = await joiner.store.get<{ detail: string }>(
        "SELECT detail FROM audit WHERE action = 'policy.change' ORDER BY ts DESC LIMIT 1",
      );
      expect(received).toBeDefined();
      expect(JSON.parse(received!.detail).seeds_relay_token).toEqual({
        $redacted: 'policy-secret',
      });
      expect(projected).toMatchObject({
        ask_fallback_to_nonadmin: true,
        doorbell: { allow: ['slack'], defaults: ['slack'] },
      });
      for (const field of [
        'ask_slack_webhook',
        'seeds_relay_url',
        'seeds_relay_token',
        'away_relay_url',
        'away_relay_token',
        'slack_bot_token',
      ])
        expect(projected).not.toHaveProperty(field);
      expect(projected.doorbell).not.toHaveProperty('slack_url');
      expect(projected.doorbell).not.toHaveProperty('webhook_url');
      expect(JSON.stringify(projected)).not.toContain('$redacted');
    });

    it('replace semantics survive the fold: a knob cleared on the hub is cleared on the joiner', async () => {
      await post(hubBase, '/teams/bravo/policy', { residency: { hourly_cap: 1 } }, nickOnHub);
      await roundTrip();
      expect((await getPolicy(joiner.store, (await joinerTeam()).id)).residency.hourly_cap).toBe(1);

      const cleared = await getPolicy(hub.store, (await hubTeam()).id); // the default the reset must restore
      await post(hubBase, '/teams/bravo/policy', {}, nickOnHub);
      await roundTrip();
      expect(await getStoredPolicy(joiner.store, (await joinerTeam()).id)).toEqual({});
      expect(
        (await getPolicy(joiner.store, (await joinerTeam()).id)).residency.hourly_cap,
      ).not.toBe(1);
      expect((await getPolicy(joiner.store, (await joinerTeam()).id)).residency.hourly_cap).toBe(
        (await getPolicy(hub.store, (await hubTeam()).id)).residency.hourly_cap,
      );
      expect(cleared.residency.hourly_cap).toBe(1); // the read above was taken BEFORE the reset
    });

    it("an admin's policy change on the JOINER is refused before it reaches the hub (ADR 729)", async () => {
      await residentOnJoiner();
      const hubBefore = await getStoredPolicy(hub.store, (await hubTeam()).id);
      const joinerBefore = await getStoredPolicy(joiner.store, (await joinerTeam()).id);

      const set = await post(
        joinerBase,
        '/teams/bravo/policy',
        { residency: { cooldown_ms: 2_400_000 } },
        nickOnJoiner,
      );
      expect(set.status).toBe(409);
      expect(set.json.error.code).toBe('hub_local_required');
      expect(await getStoredPolicy(hub.store, (await hubTeam()).id)).toEqual(hubBefore);
      expect(await getStoredPolicy(joiner.store, (await joinerTeam()).id)).toEqual(joinerBefore);
      expect(
        await joiner.store.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'policy.change'"),
      ).toEqual({ n: 0 });
    });

    it('a joiner policy-review answer refuses locally before sending policy values to the hub', async () => {
      const jt = await joinerTeam();
      await setPolicy(joiner.store, jt.id, {
        ask_fallback_to_nonadmin: true,
        review_by: Date.now() - 1,
      });
      const askId = await raisePolicyReview(joiner.store, jt, Date.now(), (from, env) =>
        insertMessage(joiner.store, jt.id, from.id, null, env),
      );
      expect(askId).toBeTruthy();
      const before = await getStoredPolicy(joiner.store, jt.id);
      const nick = (await getMemberByName(joiner.store, jt.id, 'nick'))!;

      // If this tries the old sync/policy forward, the closed hub produces hub_unreachable.
      await hub.close();
      await expect(
        answerPolicyReview(joiner.store, jt, nick, askId!, 'accept'),
      ).rejects.toMatchObject({
        code: 'hub_local_required',
      });
      expect(await getStoredPolicy(joiner.store, jt.id)).toEqual(before);
      expect(
        await joiner.store.get(
          "SELECT COUNT(*) AS n FROM audit WHERE action = 'policy.review_answered'",
        ),
      ).toEqual({ n: 0 });
    });

    it('a policy change on a joiner is refused even when its copy is stale (ADR 729)', async () => {
      // 2026-09-06 on revive: a joiner whose copy of the policy was empty forwarded the CLI's
      // read-merge-write of `--dispatch on` — `{loops:{dispatch:true}}` — and the hub stored it as
      // given, turning off its review and sweep loops and dropping its seeds relay.
      await residentOnJoiner();
      const hubDoc = {
        loops: { review: true, sweep: true },
        standing_reseat_known_agents: true,
      };
      expect((await post(hubBase, '/teams/bravo/policy', hubDoc, nickOnHub)).status).toBe(200);
      const hubStored = await getStoredPolicy(hub.store, (await hubTeam()).id);
      // No round trip: the joiner has not folded the hub's change, so its copy is still empty.
      expect(await getStoredPolicy(joiner.store, (await joinerTeam()).id)).toEqual({});

      const stale = await post(
        joinerBase,
        '/teams/bravo/policy',
        { loops: { dispatch: true } },
        nickOnJoiner,
      );
      expect(stale.status).toBe(409);
      expect(stale.json.error.code).toBe('hub_local_required');
      expect(await getStoredPolicy(hub.store, (await hubTeam()).id)).toEqual(hubStored);
      expect(await getStoredPolicy(joiner.store, (await joinerTeam()).id)).toEqual({});
    });

    it('the legacy node-authenticated policy endpoint refuses before inspecting copy freshness (ADR 729)', async () => {
      // Even a pre-587-shaped request receives the hub-local refusal, with no policy mutation.
      await residentOnJoiner();
      const hubDoc = { loops: { review: true, sweep: true } };
      expect((await post(hubBase, '/teams/bravo/policy', hubDoc, nickOnHub)).status).toBe(200);
      const before = await getStoredPolicy(hub.store, (await hubTeam()).id);

      const jt = await joinerTeam();
      const enrollment = (await joinerEnrollment(joiner.store, jt.id, 'bravo'))!;
      const res = await post(
        hubBase,
        '/teams/bravo/sync/policy',
        { actor: 'nick', policy: { loops: { dispatch: true } } },
        enrollment.credential,
      );

      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('hub_local_required');
      expect(await getStoredPolicy(hub.store, (await hubTeam()).id)).toEqual(before);
    });

    it('a joiner-side policy change with the hub down is refused as hub-local and changes nothing', async () => {
      const before = await getStoredPolicy(joiner.store, (await joinerTeam()).id);
      await hub.close();

      const res = await post(
        joinerBase,
        '/teams/bravo/policy',
        { residency: { hourly_cap: 9 } },
        nickOnJoiner,
      );
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('hub_local_required');
      expect(await getStoredPolicy(joiner.store, (await joinerTeam()).id)).toEqual(before);
      expect(
        await joiner.store.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'policy.change'"),
      ).toEqual({ n: 0 });

      hub = createServer({
        db: await openTestDriver(kind, { instance: 'c' }),
        port: 0,
        syncLoops: false,
      }); // afterEach closes a live server
      await hub.listen();
    });

    it('policy writes on a joiner do not bind the admin or alter policy', async () => {
      const before = await getStoredPolicy(joiner.store, (await joinerTeam()).id);
      const refused = await post(
        joinerBase,
        '/teams/bravo/policy',
        { residency: { hourly_cap: 3 } },
        nickOnJoiner,
      );
      expect(refused.status).toBe(409);
      expect(refused.json.error.code).toBe('hub_local_required');
      expect(await getStoredPolicy(joiner.store, (await joinerTeam()).id)).toEqual(before);
      const opened = await post(
        joinerBase,
        '/teams/bravo/lanes',
        { title: 'work from the laptop', claim: true },
        nickOnJoiner,
      );
      expect(opened.status).toBe(201);
      await roundTrip();
      expect(
        await hub.store.get("SELECT COUNT(*) AS n FROM lanes WHERE title = 'work from the laptop'"),
      ).toEqual({ n: 1 });
    });

    /**
     * The two holes gptbot's review of #1228 found, each with the machine that would have walked
     * through it. Both are about the same confusion: a node credential proves WHICH MACHINE is
     * speaking and never WHO it may speak for.
     */
    describe('an enrolled node that is not the hub cannot set policy (gptbot, 2026-09-03)', () => {
      it('node-authenticated policy writes are refused even for a resident admin', async () => {
        // nick's ordinary work on the joiner replicates, and binds the seat to that node on the hub.
        await residentOnJoiner();
        const before = await getStoredPolicy(hub.store, (await hubTeam()).id);

        const evil = await enrollSecondNode('someone elses laptop');
        const res = await post(
          hubBase,
          '/teams/bravo/sync/policy',
          { actor: 'nick', policy: { residency: { hourly_cap: 19 } } },
          evil.credential,
        );

        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe('hub_local_required');
        expect(await getStoredPolicy(hub.store, (await hubTeam()).id)).toEqual(before);
        expect(
          await hub.store.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'policy.change'"),
        ).toEqual({ n: 0 });
      });

      it('node-authenticated policy writes cannot claim an unbound admin seat', async () => {
        // The sharper half, and the reason this route uses the strict residence check rather than the
        // first-writer-wins one the lane routes use. Nobody has spoken for `ada` on any machine yet.
        // Under `assertSeatResident` the forward below would have BOUND the seat to the caller in the
        // same call that used it, and the policy would have landed.
        await post(
          hubBase,
          '/teams/bravo/members',
          { name: 'ada', kind: 'human', role: 'admin' },
          nickOnHub,
        );
        const before = await getStoredPolicy(hub.store, (await hubTeam()).id);

        const evil = await enrollSecondNode('a CI box');
        const res = await post(
          hubBase,
          '/teams/bravo/sync/policy',
          { actor: 'ada', policy: { residency: { hourly_cap: 19 } } },
          evil.credential,
        );

        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe('hub_local_required');
        expect(await getStoredPolicy(hub.store, (await hubTeam()).id)).toEqual(before);
        // The refusal must not have created the binding it refused for want of.
        expect(
          await hub.store.get(
            "SELECT COUNT(*) AS n FROM seat_nodes WHERE member_id = (SELECT id FROM members WHERE team_id = ? AND name = 'ada')",
            [(await hubTeam()).id],
          ),
        ).toEqual({ n: 0 });
      });

      it('a hand-built policy event pushed straight into the log is refused at ingest', async () => {
        const before = await getStoredPolicy(hub.store, (await hubTeam()).id);
        const evil = await enrollSecondNode('a CI box');

        // The forward above is the front door; this is the window beside it. `SyncPushRequestSchema`
        // admits `kind:'policy'` (it must — the hub's own loopback push carries them), and the kind
        // is exempt from residence, so without an origin check this event lands in `sync_log` and the
        // fold's REPLACE semantics install it as the team's policy on every machine.
        const res = await post(
          hubBase,
          '/teams/bravo/sync/push',
          {
            events: [
              {
                kind: 'policy',
                team: 'bravo',
                origin_node: evil.nodeId,
                origin_seq: 1,
                event: {
                  id: 'forged-policy-1',
                  ts: Date.now(),
                  actor: 'nick',
                  action: 'policy.change',
                  target: null,
                  result: 'allow',
                  detail: { residency: { hourly_cap: 19 } },
                },
              },
            ],
          },
          evil.credential,
        );

        expect(res.status).toBe(403);
        expect(res.json.error.message).toMatch(/policy event is the hub's to mint/);
        expect(await getStoredPolicy(hub.store, (await hubTeam()).id)).toEqual(before);
        expect(
          await hub.store.get("SELECT COUNT(*) AS n FROM sync_log WHERE id = 'forged-policy-1'"),
        ).toEqual({ n: 0 });
      });

      it('the hub’s OWN loopback push still carries policy events — the exemption is not switched off', async () => {
        // The positive control for the check above. A test that only ever refuses would have passed
        // just as happily against a build that dropped the policy kind altogether.
        await post(hubBase, '/teams/bravo/policy', { residency: { hourly_cap: 7 } }, nickOnHub);
        await roundTrip();
        expect((await getPolicy(joiner.store, (await joinerTeam()).id)).residency.hourly_cap).toBe(
          7,
        );
      });
    });

    it('a policy verb this build cannot project STOPS the fold rather than storing it', async () => {
      // The discipline every kind shares: an unknown verb from a newer origin blocks at that event,
      // retried each tick, instead of landing a transition nothing can apply.
      const result = await foldBatch(joiner.store, (await joinerTeam()).id, [
        {
          kind: 'policy',
          team: 'bravo',
          hub_seq: 9_000,
          origin_node: 'node-from-the-future',
          origin_seq: 1,
          event: {
            id: 'a-future-verb',
            ts: Date.now(),
            actor: 'nick',
            action: 'policy.rotated',
            target: null,
            result: 'allow',
            detail: {},
          },
        },
      ]);
      expect(result.stop).toEqual({
        kind: 'unknown_policy_event',
        action: 'policy.rotated',
        hub_seq: 9_000,
      });
      expect(result.applied).toBe(0);
    });
  });
});
