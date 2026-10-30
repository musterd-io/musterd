import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { localNodeForTeam } from '../store/messages.js';
import { bindSeatToNode } from '../store/nodes.js';
import { getTeamBySlug } from '../store/teams.js';
import { pullTeam } from '../sync/pull.js';
import { pushTeam } from '../sync/push.js';
import { Hub } from './hub.js';

withDrivers('authority-relay-http (ADR 728/729)', (_o, kind) => {
  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let hubNick: string;
  let joinerNick: string;
  let hubAda: string;
  let hubAgentKey: string;
  let joinerNodeState: string;
  let tempDir: string;
  let priorNodeState: string | undefined;

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

  async function patch(base: string, path: string, body: unknown, auth: string) {
    const response = await fetch(base + path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'musterd-authority-relay-'));
    priorNodeState = process.env['MUSTERD_NODE_STATE'];
    delete process.env['MUSTERD_NODE_STATE'];
    joinerNodeState = join(tempDir, 'joiner-node.json');

    hub = createServer({ db: await openTestDriver(kind), port: 0 });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({
      db: await openTestDriver(kind, { instance: 'authority-relay-joiner' }),
      port: 0,
    });
    joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;

    const hubTeam = await post(hubBase, '/teams', {
      slug: 'relay',
      creator: { name: 'nick', kind: 'human' },
    });
    hubNick = hubTeam.json.human_credential;
    hubAgentKey = hubTeam.json.agent_key;
    expect(hubNick).toMatch(/^mscr_/);
    expect(hubAgentKey).toMatch(/^mskey_/);
    const joinerTeam = await post(joinerBase, '/teams', {
      slug: 'relay',
      creator: { name: 'nick', kind: 'human' },
    });
    joinerNick = joinerTeam.json.human_credential;

    // The same roster is present on both daemons, as it is in the checked-out seat files.
    for (const [base, credential] of [
      [hubBase, hubNick],
      [joinerBase, joinerNick],
    ] as const) {
      const added = await post(
        base,
        '/teams/relay/members',
        { name: 'ada', kind: 'human' },
        credential,
      );
      expect(added.status).toBe(201);
      if (base === hubBase) hubAda = added.json.human_credential;
    }
  });

  afterEach(async () => {
    if (priorNodeState === undefined) delete process.env['MUSTERD_NODE_STATE'];
    else process.env['MUSTERD_NODE_STATE'] = priorNodeState;
    await hub.close();
    await joiner.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('relays an allowed lane acceptance to the hub once and syncs the result to the joiner', async () => {
    // Create real local node identities, enroll the joiner at the hub, and persist its node
    // credential in the joiner state file used by normal authorityAtHub calls.
    const joinerTeam = (await getTeamBySlug(joiner.store, 'relay'))!;
    const joinerNode = await localNodeForTeam(joiner.store, joinerTeam.id);
    const invite = await post(
      hubBase,
      '/teams/relay/nodes/invite',
      { label: 'relay joiner' },
      hubNick,
    );
    expect(invite.status).toBe(200);

    // Set up an ordinary acceptance ask on the hub before exposing the joiner's node state to this
    // process (MUSTERD_NODE_STATE is process-wide in the test runner).
    const hubTeam = (await getTeamBySlug(hub.store, 'relay'))!;
    const lane = await post(
      hubBase,
      '/teams/relay/lanes',
      { title: 'relay acceptance path', claim: true },
      hubAda,
    );
    expect(lane.status).toBe(201);

    const submitted = await patch(
      hubBase,
      `/teams/relay/lanes/${lane.json.lane.id}`,
      { state: 'awaiting_acceptance', acceptor: 'nick' },
      hubAda,
    );
    expect(submitted.status).toBe(200);

    const acceptanceAsks = await hub.store.all<{ id: string; meta: string | null }>(
      `SELECT id, meta FROM messages WHERE team_id = ? AND act = 'ask'`,
      [hubTeam.id],
    );
    const ask = acceptanceAsks.find((message) => {
      try {
        return JSON.parse(message.meta ?? 'null')?.lane_review?.lane === lane.json.lane.id;
      } catch {
        return false;
      }
    });
    expect(ask).toBeDefined();

    process.env['MUSTERD_NODE_STATE'] = joinerNodeState;
    const enrolled = await post(joinerBase, '/node/enroll', {
      hub_url: hubBase,
      code: invite.json.invite,
      team: 'relay',
    });
    expect(enrolled.status).toBe(200);
    expect(enrolled.json.node_id).toBe(joinerNode.id);

    // Nick is already resident on the joiner node. The hub binds that human to the enrolled node
    // before the relay, exactly as a member who uses a seat from a second machine would be.
    const hubNickRow = (await getMemberByName(hub.store, hubTeam.id, 'nick'))!;
    expect(await bindSeatToNode(hub.store, hubTeam.id, hubNickRow.id, joinerNode.id)).toMatchObject(
      { bound: true },
    );

    const joinerCtx: Ctx = {
      db: joiner.store,
      hub: new Hub(),
      config: joiner.config,
      rosterRoots: [],
    };
    const hubCtx: Ctx = {
      db: hub.store,
      hub: new Hub(),
      config: hub.config,
      rosterRoots: [],
    };
    expect(await pushTeam(hubCtx, hubTeam)).toBeGreaterThan(0);
    const pulledAskEvents = await pullTeam(joinerCtx, joinerTeam);
    const joinerAsk = await joiner.store.get(
      'SELECT id FROM messages WHERE team_id = ? AND id = ?',
      [joinerTeam.id, ask!.id],
    );
    expect(pulledAskEvents).toBeGreaterThan(0);
    expect(joinerAsk).toBeDefined();

    const acceptedEnvelope = makeEnvelope({
      id: ulid(),
      team: 'relay',
      from: 'nick',
      to: { kind: 'member', name: 'ada' },
      act: 'accept',
      body: 'Reviewed and accepted.',
      meta: { in_reply_to: ask!.id },
    });
    const accepted = await post(
      joinerBase,
      '/teams/relay/messages',
      { envelope: acceptedEnvelope },
      joinerNick,
    );
    expect(accepted.status).toBe(201);
    expect(accepted.json.lane_verdict).toEqual({ lane: lane.json.lane.id, state: 'done' });
    const acceptedMessageId = accepted.json.ack.id as string;

    const hubAnswerCount = await hub.store.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND id = ? AND act = 'accept'`,
      [hubTeam.id, acceptedMessageId],
    );
    expect(hubAnswerCount?.n).toBe(1);
    expect(
      await hub.store.get<{ state: string }>('SELECT state FROM lanes WHERE id = ?', [
        lane.json.lane.id,
      ]),
    ).toEqual({ state: 'done' });
    expect(
      await joiner.store.get('SELECT id FROM messages WHERE team_id = ? AND id = ?', [
        joinerTeam.id,
        acceptedMessageId,
      ]),
    ).toBeUndefined();

    // An explicit pull exercises the ordinary sync path, not a relay response copied into the
    // joiner database. The push's own count is not asserted: the hub's background push can stage
    // these rows first, and then this push correctly finds nothing new — on a loaded CI runner it
    // returned 0 three times on 2026-10-30. What matters is what the joiner holds after the pull.
    await pushTeam(hubCtx, hubTeam);
    await pullTeam(joinerCtx, joinerTeam);
    expect(
      await joiner.store.get('SELECT id FROM messages WHERE team_id = ? AND id = ?', [
        joinerTeam.id,
        acceptedMessageId,
      ]),
    ).toBeDefined();
    expect(
      await joiner.store.get<{ state: string }>('SELECT state FROM lanes WHERE id = ?', [
        lane.json.lane.id,
      ]),
    ).toEqual({ state: 'done' });

    const relayBody = {
      op: 'lane.answer',
      actor: 'nick',
      ask_id: ask!.id,
      act: 'accept',
      body: 'Reviewed and accepted.',
    };
    const agentCredentialAttempt = await post(
      hubBase,
      '/teams/relay/sync/authority',
      relayBody,
      hubAgentKey,
    );
    const humanCredentialAttempt = await post(
      hubBase,
      '/teams/relay/sync/authority',
      relayBody,
      hubNick,
    );
    expect(agentCredentialAttempt.status).toBe(401);
    expect(humanCredentialAttempt.status).toBe(401);
    expect(
      await hub.store.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND id = ? AND act = 'accept'`,
        [hubTeam.id, acceptedMessageId],
      ),
    ).toEqual({ n: 1 });
  });
});
