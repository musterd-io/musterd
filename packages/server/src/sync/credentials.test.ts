import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { appendAudit } from '../store/audit.js';
import { insertProvision } from '../store/hostProvisions.js';
import { addMember, getMemberByName, hashToken } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { bindHostToNode, getResidency } from '../store/residency.js';
import { findBootstrapCredential, getTeamBySlug, ROTATION_GRACE_MS } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

withDrivers('credentials', (_o, kind) => {
  /**
   * ADR 689: sponsor-scoped credentials replicate to joiners. A host key the sponsor minted on the
   * hub is honoured by the joiner's own daemon after one round trip — that is what lets a cloud
   * agent machine (ADR 647 phase 2b) run the phase-1 provisioner against `127.0.0.1` with no human
   * identity on it. Harness copied from ledger.test.ts so this file stands alone.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickOnHub: string;
  let nickOnJoiner: string;
  let joinerAgentKey: string;
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

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-credentials-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

    hub = createServer({ db: await openTestDriver(kind), port: 0, syncLoops: false });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({
      db: await openTestDriver(kind, { instance: 'b' }),
      port: 0,
      syncLoops: false,
    });
    joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
    joinerCtx = { db: joiner.store, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };

    nickOnHub = (
      await post(hubBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    const joinerCreated = (
      await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json;
    nickOnJoiner = joinerCreated.human_credential;
    joinerAgentKey = joinerCreated.agent_key;
    await addMember(hub.store, await hubTeam(), { name: 'ada', kind: 'agent' });
    await addMember(joiner.store, await joinerTeam(), { name: 'ada', kind: 'agent' });

    // The joiner's node row is minted on its first logged act. It is ada's, not nick's: a human's
    // first replicated act binds them to that node (ADR 360), and these cases need nick bound to
    // the HUB — the laptop — so a human-authored joiner row is refused the way it is in life.
    const jt = await joinerTeam();
    await insertMessage(
      joiner.store,
      jt.id,
      (await getMemberByName(joiner.store, jt.id, 'ada'))!.id,
      null,
      makeEnvelope({
        id: 'j-0',
        team: 'bravo',
        from: 'ada',
        to: { kind: 'team' },
        act: 'message',
        body: 'hi',
        ts: 1000,
      }),
    );
    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'agent machine' },
      nickOnHub,
    );
    expect(
      (
        await post(joinerBase, '/node/enroll', {
          hub_url: hubBase,
          code: minted.invite,
          team: 'bravo',
        })
      ).status,
    ).toBe(200);
  });

  afterEach(async () => {
    await hub.close().catch(() => undefined);
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe('ADR 689 — a hub-minted sponsor host key is honoured at the joiner', () => {
    it('1. a host key minted on the hub authenticates a wake-lease poll at the joiner after one round trip', async () => {
      const hk = await post(
        hubBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'host', target: 'cloud-ada' },
        nickOnHub,
      );
      expect(hk.status).toBe(201);
      const hostKey = hk.json.agent_key as string;

      const before = await post(
        joinerBase,
        '/teams/bravo/residency/wake-leases',
        { host: 'cloud-ada' },
        hostKey,
      );
      expect(before.status).toBe(401);

      await roundTrip();

      const after = await post(
        joinerBase,
        '/teams/bravo/residency/wake-leases',
        { host: 'cloud-ada' },
        hostKey,
      );
      expect(after.status).toBe(200);
    });

    it('2. revoking the host key on the hub ends it at the joiner on the next round trip', async () => {
      const hk = await post(
        hubBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'host', target: 'cloud-ada' },
        nickOnHub,
      );
      const hostKey = hk.json.agent_key as string;
      const credentialId = hk.json.credential.id as string;
      await roundTrip();
      expect(
        (
          await post(
            joinerBase,
            '/teams/bravo/residency/wake-leases',
            { host: 'cloud-ada' },
            hostKey,
          )
        ).status,
      ).toBe(200);

      const revoked = await fetch(
        `${hubBase}/teams/bravo/agent-bootstrap-credentials/${credentialId}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${nickOnHub}` } },
      );
      expect(revoked.status).toBe(200);
      await roundTrip();

      expect(
        (
          await post(
            joinerBase,
            '/teams/bravo/residency/wake-leases',
            { host: 'cloud-ada' },
            hostKey,
          )
        ).status,
      ).toBe(401);
    });

    it('2b. a hub rotation rotates the projected predecessor at the joiner, which then lapses on the grace window (ADR 775)', async () => {
      const first = await post(
        hubBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'host', target: 'cloud-ada' },
        nickOnHub,
      );
      const firstKey = first.json.agent_key as string;
      await roundTrip();
      const second = await post(
        hubBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'host', target: 'cloud-ada' },
        nickOnHub,
      );
      const secondKey = second.json.agent_key as string;
      await roundTrip();

      const team = await joinerTeam();
      const row = await joiner.store.get<{ state: string; rotated_at: number | null }>(
        'SELECT state, rotated_at FROM agent_bootstrap_credentials WHERE id = ?',
        [first.json.credential.id],
      );
      expect(row?.state).toBe('rotated');
      // Anchored on the hub's rotation (the successor's mint), not on when the joiner folded it.
      expect(row?.rotated_at).toBe(second.json.credential.created_at);
      const rotatedAt = row!.rotated_at!;
      // Inside the window both keys still poll, so a staged move is not cut off mid-flight.
      for (const key of [firstKey, secondKey]) {
        expect(
          (await post(joinerBase, '/teams/bravo/residency/wake-leases', { host: 'cloud-ada' }, key))
            .status,
        ).toBe(200);
      }
      const past = rotatedAt + ROTATION_GRACE_MS;
      expect(await findBootstrapCredential(joiner.store, team.id, firstKey, past)).toBeNull();
      expect(await findBootstrapCredential(joiner.store, team.id, secondKey, past)).toMatchObject({
        id: second.json.credential.id,
        state: 'active',
      });
    });

    it('3. a joiner cannot author a credential fact: a forged credential.accepted is refused at the hub`s ingest', async () => {
      const forgedKey = 'msak_forged_by_the_joiner';
      await appendAudit(joiner.store, (await joinerTeam()).id, {
        actor: null,
        action: 'credential.accepted',
        target: 'forged-credential-id',
        result: 'allow',
        detail: {
          use: 'host',
          target: 'cloud-ada',
          sponsor: 'nick',
          key_hash: hashToken(forgedKey),
          created_at: Date.now(),
        },
      });
      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/403/);
      expect(
        (
          await post(
            hubBase,
            '/teams/bravo/residency/wake-leases',
            { host: 'cloud-ada' },
            forgedKey,
          )
        ).status,
      ).toBe(401);
    });

    it('3b. a joiner cannot vouch for a sponsorship: a pushed member.sponsored_agent_created is refused at the hub (ADR 700)', async () => {
      await appendAudit(joiner.store, (await joinerTeam()).id, {
        actor: 'nick',
        action: 'member.sponsored_agent_created',
        target: 'forged-scout',
        result: 'allow',
      });
      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/403/);
      const hubTeamRow = await hubTeam();
      expect(
        await hub.store.get(
          "SELECT id FROM audit WHERE team_id = ? AND action = 'member.sponsored_agent_created' AND target = 'forged-scout'",
          [hubTeamRow.id],
        ),
      ).toBeUndefined();
    });

    it('4. a replicated key is sponsor-only at the joiner: an admin`s hub-minted key gets no order for an unsponsored seat there', async () => {
      // ada is unsponsored on both rosters. On the hub an admin's host key is team-wide and would
      // serve her; the replicated copy at the joiner must not (ADR 689 decision 2).
      const hubKey = (
        await post(
          hubBase,
          '/teams/bravo/agent-bootstrap-credentials',
          { use: 'host', target: 'cloud-ada' },
          nickOnHub,
        )
      ).json.agent_key as string;
      await roundTrip();

      const jt = await joinerTeam();
      expect(
        (
          await post(
            joinerBase,
            '/teams/bravo/residency/enroll',
            { seat: 'ada', harness: 'claude-code', host: 'cloud-ada' },
            nickOnJoiner,
          )
        ).status,
      ).toBe(201);
      const nick = (await getMemberByName(joiner.store, jt.id, 'nick'))!;
      const ada = (await getMemberByName(joiner.store, jt.id, 'ada'))!;
      await insertMessage(
        joiner.store,
        jt.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 'j-ask-ada',
          team: 'bravo',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'request_help',
          body: 'ada, a hand?',
          ts: Date.now(),
        }),
      );

      const replicated = await post(
        joinerBase,
        '/teams/bravo/residency/wake-leases',
        { host: 'cloud-ada' },
        hubKey,
      );
      expect(replicated.status).toBe(200);
      expect(replicated.json.orders).toEqual([]);

      // A credential-mint operation stays hub-local and must refuse before creating a key.
      const countBeforeLocalMint = await joiner.store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM agent_bootstrap_credentials WHERE team_id = ? AND target = 'cloud-ada'",
        [jt.id],
      );
      const localMint = await post(
        joinerBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'host', target: 'cloud-ada' },
        nickOnJoiner,
      );
      expect(localMint.status).toBe(409);
      expect(localMint.json.error.code).toBe('hub_local_required');
      expect(
        await joiner.store.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_bootstrap_credentials WHERE team_id = ? AND target = 'cloud-ada'",
          [jt.id],
        ),
      ).toEqual(countBeforeLocalMint);
    });

    it('5. a joiner refuses a human credential mint before inserting a credential row', async () => {
      const refused = await post(
        joinerBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'host', target: 'joiner-only' },
        nickOnJoiner,
      );
      expect(refused.status).toBe(409);
      expect(refused.json.error.code).toBe('hub_local_required');
      await expect(roundTrip()).resolves.toBeUndefined();
      expect(
        await joiner.store.get(
          "SELECT id FROM agent_bootstrap_credentials WHERE team_id = ? AND target = 'joiner-only'",
          [(await joinerTeam()).id],
        ),
      ).toBeUndefined();
      expect(
        await hub.store.get(
          "SELECT id FROM agent_bootstrap_credentials WHERE team_id = ? AND target = 'joiner-only'",
          [(await hubTeam()).id],
        ),
      ).toBeUndefined();
    });

    it('6. a joiner refuses to revoke a replicated credential — the revoke is the hub`s — and the key keeps working there', async () => {
      const hk = await post(
        hubBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'host', target: 'cloud-ada' },
        nickOnHub,
      );
      const hostKey = hk.json.agent_key as string;
      const credentialId = hk.json.credential.id as string;
      await roundTrip();

      const revoked = await fetch(
        `${joinerBase}/teams/bravo/agent-bootstrap-credentials/${credentialId}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${nickOnJoiner}` } },
      );
      expect(revoked.status).toBe(403);
      expect(((await revoked.json()) as any).error.message).toMatch(/hub/);
      expect(
        (
          await post(
            joinerBase,
            '/teams/bravo/residency/wake-leases',
            { host: 'cloud-ada' },
            hostKey,
          )
        ).status,
      ).toBe(200);
    });
  });

  describe('ADR 689 decision 7 — privileged verbs at a joiner need fresh hub authority; wakes do not', () => {
    it('7. a replicated host key mints a sponsored seat`s credential while the pull is fresh, is refused past the window, and still polls', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      const nickHub = (await getMemberByName(hub.store, ht.id, 'nick'))!;
      const nickJoiner = (await getMemberByName(joiner.store, jt.id, 'nick'))!;
      await addMember(hub.store, ht, { name: 'bea', kind: 'agent', sponsoredBy: nickHub.id });
      await addMember(joiner.store, jt, { name: 'bea', kind: 'agent', sponsoredBy: nickJoiner.id });
      const hostKey = (
        await post(
          hubBase,
          '/teams/bravo/agent-bootstrap-credentials',
          { use: 'host', target: 'cloud-bea' },
          nickOnHub,
        )
      ).json.agent_key as string;
      await roundTrip();

      const fresh = await post(
        joinerBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'bea' },
        hostKey,
      );
      expect(fresh.status).toBe(201);

      await joiner.store.run('UPDATE sync_pull_cursor SET updated_at = ? WHERE team_id = ?', [
        Date.now() - 16 * 60_000,
        jt.id,
      ]);
      const stale = await post(
        joinerBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'bea' },
        hostKey,
      );
      expect(stale.status).toBe(503);
      expect(stale.json.error.code).toBe('hub_unreachable');

      expect(
        (
          await post(
            joinerBase,
            '/teams/bravo/residency/wake-leases',
            { host: 'cloud-bea' },
            hostKey,
          )
        ).status,
      ).toBe(200);
    });
  });

  describe('ADR 689 decision 5 — a host-key-authored row names the host as actor and pushes without a human', () => {
    it('8. a replicated host key enrols its sponsored seat at the joiner, and the enrolment reaches the hub roster without node trust', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      const nickHub = (await getMemberByName(hub.store, ht.id, 'nick'))!;
      const nickJoiner = (await getMemberByName(joiner.store, jt.id, 'nick'))!;
      await addMember(hub.store, ht, { name: 'bea', kind: 'agent', sponsoredBy: nickHub.id });
      await addMember(joiner.store, jt, { name: 'bea', kind: 'agent', sponsoredBy: nickJoiner.id });
      const hostKey = (
        await post(
          hubBase,
          '/teams/bravo/agent-bootstrap-credentials',
          { use: 'host', target: 'cloud-bea' },
          nickOnHub,
        )
      ).json.agent_key as string;
      // nick's first replicated act is on the hub: that is where nick is bound (ADR 360).
      await insertMessage(
        hub.store,
        ht.id,
        nickHub.id,
        null,
        makeEnvelope({
          id: 'h-0',
          team: 'bravo',
          from: 'nick',
          to: { kind: 'team' },
          act: 'message',
          body: 'hub first',
          ts: Date.now(),
        }),
      );
      await pushTeam(hubCtx(), ht);
      await roundTrip();

      const enrol = await post(
        joinerBase,
        '/teams/bravo/residency/enroll',
        { seat: 'bea', harness: 'musterd', host: 'cloud-bea' },
        hostKey,
      );
      expect(enrol.status).toBe(201);

      await expect(roundTrip()).resolves.toBeUndefined();
      const beaHub = (await getMemberByName(hub.store, ht.id, 'bea'))!;
      const folded = await getResidency(hub.store, ht.id, beaHub.id);
      expect(folded?.host).toBe('cloud-bea');
      const row = await hub.store.get<{ actor: string | null; detail: string }>(
        "SELECT actor, detail FROM audit WHERE team_id = ? AND action = 'residency.enrolled' AND target = 'bea'",
        [ht.id],
      );
      expect(row?.actor).toBe('cloud-bea');
      expect(JSON.parse(row!.detail)).toMatchObject({ actor_kind: 'host', sponsor: 'nick' });
    });

    it('9. a human-authored joiner row is still refused bound_elsewhere — the host actor is the only way through', async () => {
      const ht = await hubTeam();
      const nickHub = (await getMemberByName(hub.store, ht.id, 'nick'))!;
      await insertMessage(
        hub.store,
        ht.id,
        nickHub.id,
        null,
        makeEnvelope({
          id: 'h-0',
          team: 'bravo',
          from: 'nick',
          to: { kind: 'team' },
          act: 'message',
          body: 'hub first',
          ts: Date.now(),
        }),
      );
      await pushTeam(hubCtx(), ht);
      await roundTrip();
      expect(
        (
          await post(
            joinerBase,
            '/teams/bravo/residency/enroll',
            { seat: 'ada', harness: 'claude-code', host: 'laptop-two' },
            nickOnJoiner,
          )
        ).status,
      ).toBe(201);
      await expect(roundTrip()).rejects.toThrow(/403/);
    });

    it('10. a host row pushed from a node the label is not bound to is refused', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      expect(
        (
          await post(
            hubBase,
            '/teams/bravo/agent-bootstrap-credentials',
            { use: 'host', target: 'cloud-elsewhere' },
            nickOnHub,
          )
        ).status,
      ).toBe(201);
      await bindHostToNode(hub.store, ht.id, 'cloud-elsewhere', 'some-other-node');
      await appendAudit(joiner.store, jt.id, {
        actor: 'cloud-elsewhere',
        action: 'residency.enrolled',
        target: 'ada',
        result: 'allow',
        detail: {
          harness: 'musterd',
          host: 'cloud-elsewhere',
          authorized_by: 'nick',
          via: 'host_key',
          actor_kind: 'host',
          sponsor: 'nick',
        },
      });
      await expect(roundTrip()).rejects.toThrow(/403/);
      expect(
        await getResidency(hub.store, ht.id, (await getMemberByName(hub.store, ht.id, 'ada'))!.id),
      ).toBeNull();
    });

    it('12. a self-declared host actor that is a member`s name, or no live host key`s label, does not skip the seat check', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      const nickHub = (await getMemberByName(hub.store, ht.id, 'nick'))!;
      await insertMessage(
        hub.store,
        ht.id,
        nickHub.id,
        null,
        makeEnvelope({
          id: 'h-0',
          team: 'bravo',
          from: 'nick',
          to: { kind: 'team' },
          act: 'message',
          body: 'hub first',
          ts: Date.now(),
        }),
      );
      await pushTeam(hubCtx(), ht);
      await roundTrip();
      // nick is bound to the hub; a joiner row in nick's name wearing actor_kind 'host' is still nick's row.
      await appendAudit(joiner.store, jt.id, {
        actor: 'nick',
        action: 'residency.enrolled',
        target: 'ada',
        result: 'allow',
        detail: { harness: 'musterd', host: 'nick', authorized_by: 'nick', actor_kind: 'host' },
      });
      await expect(roundTrip()).rejects.toThrow(/403/);
      expect(
        await hub.store.get('SELECT node FROM host_liveness WHERE team_id = ? AND host = ?', [
          ht.id,
          'nick',
        ]),
      ).toBeUndefined();
    });
  });

  describe('ADR 689 decision 6 — a joiner`s mint is a request; the hub validates and writes the fact', () => {
    it('11. a claim_seat minted at the joiner under the replicated host key reaches the hub as a hub-origin credential.accepted, recorded there and never a bearer there', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      const nickHub = (await getMemberByName(hub.store, ht.id, 'nick'))!;
      const nickJoiner = (await getMemberByName(joiner.store, jt.id, 'nick'))!;
      await addMember(hub.store, ht, { name: 'bea', kind: 'agent', sponsoredBy: nickHub.id });
      await addMember(joiner.store, jt, { name: 'bea', kind: 'agent', sponsoredBy: nickJoiner.id });
      const hostKey = (
        await post(
          hubBase,
          '/teams/bravo/agent-bootstrap-credentials',
          { use: 'host', target: 'cloud-bea' },
          nickOnHub,
        )
      ).json.agent_key as string;
      await roundTrip();

      const minted = await post(
        joinerBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'bea' },
        hostKey,
      );
      expect(minted.status).toBe(201);
      const credentialId = minted.json.credential.id as string;
      const keyHash = hashToken(minted.json.agent_key as string);

      await roundTrip();
      // The hub RECORDS the acceptance under its own origin; it never inserts a bearer from a
      // pushed row — a seat credential authenticates only where it was minted.
      expect(
        await hub.store.get(
          'SELECT id FROM agent_bootstrap_credentials WHERE id = ? AND team_id = ?',
          [credentialId, ht.id],
        ),
      ).toBeUndefined();
      const hubNode = (await hub.store.get<{ node_id: string }>(
        'SELECT node_id FROM local_node WHERE team_id = ?',
        [ht.id],
      ))!.node_id;
      const joinerNode = (await joiner.store.get<{ node_id: string }>(
        'SELECT node_id FROM local_node WHERE team_id = ?',
        [jt.id],
      ))!.node_id;
      const accepted = await hub.store.get<{ origin_node: string; detail: string }>(
        "SELECT origin_node, detail FROM audit WHERE team_id = ? AND action = 'credential.accepted' AND target = ?",
        [ht.id, credentialId],
      );
      expect(accepted?.origin_node).toBe(hubNode);
      expect(JSON.parse(accepted!.detail)).toMatchObject({
        requested_from: joinerNode,
        key_hash: keyHash,
        target: 'bea',
      });
      // …and the minting joiner still holds its own live row, untouched by the round trip.
      expect(
        await joiner.store.get<{ state: string; replicated_from: string | null }>(
          'SELECT state, replicated_from FROM agent_bootstrap_credentials WHERE id = ?',
          [credentialId],
        ),
      ).toEqual({ state: 'active', replicated_from: null });
    });
  });

  describe('ADR 762 follow-up — the hub fold honours a claimed move row for an unsponsored seat', () => {
    it('11b. a joiner host finishing a hub-authored move mints the seat`s claim key there, and the hub accepts the request', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      const nickHub = (await getMemberByName(hub.store, ht.id, 'nick'))!;
      const cora = (await addMember(hub.store, ht, { name: 'cora', kind: 'agent' })).row;
      await addMember(joiner.store, jt, { name: 'cora', kind: 'agent' });
      const hostKey = (
        await post(
          hubBase,
          '/teams/bravo/agent-bootstrap-credentials',
          { use: 'host', target: 'cloud-cora' },
          nickOnHub,
        )
      ).json.agent_key as string;
      // The move the hub authorized (ADR 696), pinned to the joiner's host label (ADR 703), with
      // the ledger fact `sync/move.ts` writes beside it so the row projects to the joiner.
      const move = { harness: 'claude-code', policy: null };
      const now = Date.now();
      const row = await insertProvision(
        hub.store,
        ht.id,
        cora.id,
        nickHub.id,
        now,
        null,
        'cloud-cora',
        'move',
        JSON.stringify(move),
      );
      await appendAudit(hub.store, ht.id, {
        actor: null,
        action: 'host.provision_pending',
        target: row.id,
        result: 'allow',
        detail: {
          agent: 'cora',
          sponsor: 'nick',
          host: 'cloud-cora',
          connect_origin: null,
          created_at: now,
          kind: 'move',
          move,
        },
      });
      await roundTrip();
      const claim = await post(
        joinerBase,
        '/teams/bravo/host/provisions',
        { host: 'cloud-cora', kinds: ['move'] },
        hostKey,
      );
      expect(claim.json.provisions.map((p: { agent: string }) => p.agent)).toEqual(['cora']);
      await roundTrip();

      const minted = await post(
        joinerBase,
        '/teams/bravo/agent-bootstrap-credentials',
        { use: 'claim_seat', target: 'cora' },
        hostKey,
      );
      expect(minted.status).toBe(201);
      const credentialId = minted.json.credential.id as string;
      await roundTrip();
      const verdicts = await hub.store.all<{ action: string; detail: string }>(
        "SELECT action, detail FROM audit WHERE team_id = ? AND action IN ('credential.accepted', 'credential.refused') AND target = ?",
        [ht.id, credentialId],
      );
      expect(verdicts.map((v) => v.action)).toEqual(['credential.accepted']);
    });
  });

  describe('ADR 689 decision 3 — a cloud joiner`s host is live at the hub, so a pinned mint can name it', () => {
    it('13. a replicated host key`s poll at the joiner reaches the hub as one heartbeat per window, and the hub then pins a mint to that label', async () => {
      const ht = await hubTeam();
      const hostKey = (
        await post(
          hubBase,
          '/teams/bravo/agent-bootstrap-credentials',
          { use: 'host', target: 'cloud-bea' },
          nickOnHub,
        )
      ).json.agent_key as string;
      await roundTrip();

      // Before any poll reaches the hub, the label is unseen there and a pinned mint is refused.
      const unseen = await post(
        hubBase,
        '/teams/bravo/members/agents',
        { name: 'cal', host: 'cloud-bea' },
        nickOnHub,
      );
      expect(unseen.status).toBe(409);

      for (let i = 0; i < 3; i += 1) {
        expect(
          (
            await post(
              joinerBase,
              '/teams/bravo/residency/wake-leases',
              { host: 'cloud-bea' },
              hostKey,
            )
          ).status,
        ).toBe(200);
      }
      await roundTrip();

      const seen = await hub.store.get<{ seen_at: number; node: string | null }>(
        'SELECT seen_at, node FROM host_liveness WHERE team_id = ? AND host = ?',
        [ht.id, 'cloud-bea'],
      );
      expect(seen?.seen_at).toBeGreaterThan(Date.now() - 60_000);
      expect(seen?.node).not.toBeNull();
      const heartbeats = await hub.store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit WHERE team_id = ? AND action = 'residency.host_seen' AND target = 'cloud-bea'",
        [ht.id],
      );
      expect(Number(heartbeats?.n)).toBe(1);

      const pinned = await post(
        hubBase,
        '/teams/bravo/members/agents',
        { name: 'cal', host: 'cloud-bea' },
        nickOnHub,
      );
      expect(pinned.status).toBe(201);
      expect(pinned.json).toMatchObject({ hosting: 'sponsor_host', host: 'cloud-bea' });
    });

    it('14. a pinned provision reaches the joiner; its host claims and reports ready there; the hub`s row follows', async () => {
      const ht = await hubTeam();
      const jt = await joinerTeam();
      expect(
        (
          await post(
            hubBase,
            '/teams/bravo/policy',
            { agent_host: { policy: { budget_usd: 2 } } },
            nickOnHub,
          )
        ).status,
      ).toBe(200);
      const hostKey = (
        await post(
          hubBase,
          '/teams/bravo/agent-bootstrap-credentials',
          { use: 'host', target: 'cloud-bea' },
          nickOnHub,
        )
      ).json.agent_key as string;
      await roundTrip();
      await post(joinerBase, '/teams/bravo/residency/wake-leases', { host: 'cloud-bea' }, hostKey);
      await roundTrip();
      const minted = await post(
        hubBase,
        '/teams/bravo/members/agents',
        { name: 'cal', host: 'cloud-bea' },
        nickOnHub,
      );
      expect(minted.status).toBe(201);
      // Roster identity replicates via git (ADR 058): cal exists on the joiner too, sponsored by nick.
      const nickJoiner = (await getMemberByName(joiner.store, jt.id, 'nick'))!;
      await addMember(joiner.store, jt, { name: 'cal', kind: 'agent', sponsoredBy: nickJoiner.id });
      await roundTrip();

      const claim = await post(
        joinerBase,
        '/teams/bravo/host/provisions',
        { host: 'cloud-bea' },
        hostKey,
      );
      expect(claim.status).toBe(200);
      expect(claim.json.provisions).toHaveLength(1);
      expect(claim.json.provisions[0]).toMatchObject({
        agent: 'cal',
        sponsor: 'nick',
        state: 'claimed',
        claimed_by: 'cloud-bea',
      });
      const provisionId = claim.json.provisions[0].id as string;
      expect(
        (await post(joinerBase, '/teams/bravo/host/provisions', { host: 'cloud-bea' }, hostKey))
          .json.provisions,
      ).toEqual([]);
      const report = await post(
        joinerBase,
        `/teams/bravo/host/provisions/${provisionId}/report`,
        { state: 'ready' },
        hostKey,
      );
      expect(report.status).toBe(200);

      await roundTrip();
      const hubRow = await hub.store.get<{ state: string; claimed_by: string | null }>(
        'SELECT state, claimed_by FROM host_provisions WHERE id = ? AND team_id = ?',
        [provisionId, ht.id],
      );
      expect(hubRow).toEqual({ state: 'ready', claimed_by: 'cloud-bea' });
    });

    it('16. a legacy team key polling at the joiner stages no heartbeat — only a scoped host credential speaks for a label', async () => {
      const ht = await hubTeam();
      expect(
        (
          await post(
            joinerBase,
            '/teams/bravo/residency/wake-leases',
            { host: 'legacy-host' },
            joinerAgentKey,
          )
        ).status,
      ).toBe(200);
      await roundTrip();
      expect(
        await hub.store.get(
          "SELECT id FROM audit WHERE team_id = ? AND action = 'residency.host_seen' AND target = 'legacy-host'",
          [ht.id],
        ),
      ).toBeUndefined();
      expect(
        await hub.store.get('SELECT host FROM host_liveness WHERE team_id = ? AND host = ?', [
          ht.id,
          'legacy-host',
        ]),
      ).toBeUndefined();
    });
  });

  describe('ADR 689 decision 6 — two joiners: the hub`s facts reach both, a forged one reaches neither', () => {
    it('15. a hub-minted host key is honoured at a second joiner, and a forged acceptance staged on the first never reaches it', async () => {
      // A second joiner, enrolled at the same hub with its own invite.
      const second = createServer({
        db: await openTestDriver(kind, { instance: 'c' }),
        port: 0,
        syncLoops: false,
      });
      const secondBase = `http://127.0.0.1:${(await second.listen()).port}`;
      const secondCtx: Ctx = {
        db: second.store,
        hub: new Hub(),
        config: resolveConfig(),
        rosterRoots: [],
      };
      try {
        await post(secondBase, '/teams', {
          slug: 'bravo',
          creator: { name: 'nick', kind: 'human' },
        });
        const st = (await getTeamBySlug(second.store, 'bravo'))!;
        await addMember(second.store, st, { name: 'ada', kind: 'agent' });
        await insertMessage(
          second.store,
          st.id,
          (await getMemberByName(second.store, st.id, 'ada'))!.id,
          null,
          makeEnvelope({
            id: 'c-0',
            team: 'bravo',
            from: 'ada',
            to: { kind: 'team' },
            act: 'message',
            body: 'second joiner',
            ts: 1001,
          }),
        );
        const invite = (
          await post(hubBase, '/teams/bravo/nodes/invite', { label: 'second machine' }, nickOnHub)
        ).json.invite as string;
        // One node file holds one team; the second joiner enrols under its own state file.
        const firstState = process.env['MUSTERD_NODE_STATE']!;
        process.env['MUSTERD_NODE_STATE'] = join(dir, 'node-second.json');
        expect(
          (
            await post(secondBase, '/node/enroll', {
              hub_url: hubBase,
              code: invite,
              team: 'bravo',
            })
          ).status,
        ).toBe(200);
        const secondTrip = async () => {
          await pushTeam(secondCtx, st);
          await pullTeam(hubCtx(), await hubTeam());
          await pushTeam(hubCtx(), await hubTeam());
          await pullTeam(secondCtx, st);
        };
        process.env['MUSTERD_NODE_STATE'] = firstState;

        const hostKey = (
          await post(
            hubBase,
            '/teams/bravo/agent-bootstrap-credentials',
            { use: 'host', target: 'cloud-two' },
            nickOnHub,
          )
        ).json.agent_key as string;
        // The first joiner also stages a forged acceptance for a key nobody minted.
        const forgedKey = 'msak_forged_on_joiner_one';
        await appendAudit(joiner.store, (await joinerTeam()).id, {
          actor: null,
          action: 'credential.accepted',
          target: 'forged-two',
          result: 'allow',
          detail: {
            use: 'host',
            target: 'cloud-two',
            sponsor: 'nick',
            key_hash: hashToken(forgedKey),
            created_at: Date.now(),
          },
        });
        await expect(roundTrip()).rejects.toThrow(/403/);
        process.env['MUSTERD_NODE_STATE'] = join(dir, 'node-second.json');
        await secondTrip();
        process.env['MUSTERD_NODE_STATE'] = firstState;

        expect(
          (
            await post(
              secondBase,
              '/teams/bravo/residency/wake-leases',
              { host: 'cloud-two' },
              hostKey,
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await post(
              secondBase,
              '/teams/bravo/residency/wake-leases',
              { host: 'cloud-two' },
              forgedKey,
            )
          ).status,
        ).toBe(401);
      } finally {
        await second.close();
      }
    });
  });
});
