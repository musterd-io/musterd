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
import { addMember, getMemberByName, hashToken } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
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
    nickOnJoiner = (
      await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
    await addMember(hub.store, await hubTeam(), { name: 'ada', kind: 'agent' });
    await addMember(joiner.store, await joinerTeam(), { name: 'ada', kind: 'agent' });

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

      // Control: the same admin's key minted AT the joiner is team-wide there and takes the order.
      const localKey = (
        await post(
          joinerBase,
          '/teams/bravo/agent-bootstrap-credentials',
          { use: 'host', target: 'cloud-ada' },
          nickOnJoiner,
        )
      ).json.agent_key as string;
      const local = await post(
        joinerBase,
        '/teams/bravo/residency/wake-leases',
        { host: 'cloud-ada' },
        localKey,
      );
      expect(local.status).toBe(200);
      expect(local.json.orders.map((o: any) => o.seat)).toEqual(['ada']);
    });

    it('5. a joiner-side mint never poisons the joiner`s push: it stages no credential fact of its own', async () => {
      expect(
        (
          await post(
            joinerBase,
            '/teams/bravo/agent-bootstrap-credentials',
            { use: 'host', target: 'joiner-only' },
            nickOnJoiner,
          )
        ).status,
      ).toBe(201);
      await expect(roundTrip()).resolves.toBeUndefined();
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
});
