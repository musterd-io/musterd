import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { makeEnvelope, descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { humanAskAnswerApproval, requestDecisionApproval } from '@musterd/protocol/approval';
import { ulid } from 'ulid';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { enrollDeviceKey } from '../store/authority.js';
import { getMemberByName } from '../store/members.js';
import { createRequest } from '../store/requests.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('human-authority-followthrough', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let nick: string;
  let ada: AgentHttpAuth;
  let keyId: string;
  let privateKey: KeyObject;

  async function call(
    method: string,
    path: string,
    auth: string | AgentHttpAuth,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${typeof auth === 'string' ? auth : auth.key}`,
        ...(typeof auth === 'object'
          ? { 'x-musterd-session-lease': auth.sessionLease, 'x-musterd-seat': 'ada' }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};
    return {
      status: res.status,
      json:
        typeof json === 'object' && json !== null && !Array.isArray(json)
          ? (json as Record<string, unknown>)
          : {},
    };
  }

  async function descriptor(input: {
    act: string;
    target: string;
    payload: unknown;
  }): Promise<ApprovalDescriptor> {
    const res = await call('POST', '/teams/dawn/authority/descriptors', nick, input);
    expect(res.status).toBe(201);
    return res.json.descriptor as ApprovalDescriptor;
  }

  function proof(d: ApprovalDescriptor) {
    return {
      key_id: keyId,
      nonce: d.nonce,
      signature: cryptoSign(
        null,
        Buffer.from(descriptorSigningBytes(d), 'utf8'),
        privateKey,
      ).toString('base64url'),
    };
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
    const created = await call('POST', '/teams', '', {
      slug: 'dawn',
      creator: { name: 'nick', kind: 'human' },
    });
    nick = created.json.human_credential as string;
    await call('POST', '/teams/dawn/members', nick, { name: 'ada', kind: 'agent' });
    ada = await claimAgentHttp(base, 'dawn', created.json.agent_key as string, nick, 'ada');

    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    const human = (await getMemberByName(server.store, team.id, 'nick'))!;
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    const key = await enrollDeviceKey(server.store, {
      teamId: team.id,
      memberId: human.id,
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      kind: 'platform',
    });
    keyId = key.id;
  });

  afterEach(async () => {
    await server.close();
  });

  it('requires A2 for a human answer to a privileged agent ask and stamps only a checked answer', async () => {
    const askId = ulid();
    const ask = makeEnvelope({
      id: askId,
      team: 'dawn',
      from: 'ada',
      to: { kind: 'member', name: 'nick' },
      act: 'ask',
      body: 'Approve this operation?',
      meta: { species: 'approve', tier: 'standard' },
      ts: Date.now(),
    });
    expect((await call('POST', '/teams/dawn/messages', ada, { envelope: ask })).status).toBe(201);

    const answerId = ulid();
    const reply = (approval?: unknown) =>
      makeEnvelope({
        id: answerId,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'accept',
        thread: askId,
        // A client-supplied marker is untrusted; the route must strip it before checking authority.
        meta: {
          in_reply_to: askId,
          human_authority_checked: true,
          ...(approval ? { approval } : {}),
        },
        ts: Date.now(),
      });
    const refused = await call('POST', '/teams/dawn/messages', nick, { envelope: reply() });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('no_signature');

    const approval = humanAskAnswerApproval(askId, 'accept');
    const d = await descriptor(approval);
    const accepted = await call('POST', '/teams/dawn/messages', nick, {
      envelope: reply(proof(d)),
    });
    expect(accepted.status).toBe(201);
    const stored = await server.store.get<{ meta: string }>(
      'SELECT meta FROM messages WHERE id = ?',
      [answerId],
    );
    expect(JSON.parse(stored!.meta)).toMatchObject({ human_authority_checked: true });
  });

  it('requires A2 for approve on request.decide before settling the request', async () => {
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    const request = await createRequest(server.store, team.id, {
      kind: 'claim',
      from_session: 'http:waiting-session',
      target: 'seat:ada',
      surface: 'cli',
    });
    const path = `/teams/dawn/requests/${encodeURIComponent(request.id)}/decide`;
    const unsigned = await call('POST', path, nick, { decision: 'approve', lifetime: 'once' });
    expect(unsigned.status).toBe(403);
    expect(JSON.stringify(unsigned.json)).toContain('no_signature');
    expect(
      (
        await server.store.get<{ status: string }>('SELECT status FROM requests WHERE id = ?', [
          request.id,
        ])
      )?.status,
    ).toBe('pending');

    const approval = requestDecisionApproval({
      requestId: request.id,
      requestTarget: request.target,
      decision: 'approve',
      lifetime: 'once',
    });
    const d = await descriptor(approval);
    const decided = await call('POST', path, nick, {
      decision: 'approve',
      lifetime: 'once',
      approval: proof(d),
    });
    expect(decided.status).toBe(200);
    expect(decided.json.decision).toBe('approve');
  });

  it('requires A2 for deny on request.decide before settling the request', async () => {
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    const request = await createRequest(server.store, team.id, {
      kind: 'claim',
      from_session: 'http:waiting-session-deny',
      target: 'seat:ada',
      surface: 'cli',
    });
    const path = `/teams/dawn/requests/${encodeURIComponent(request.id)}/decide`;
    const unsigned = await call('POST', path, nick, { decision: 'deny' });
    expect(unsigned.status).toBe(403);
    expect(JSON.stringify(unsigned.json)).toContain('no_signature');
    expect(
      (
        await server.store.get<{ status: string }>('SELECT status FROM requests WHERE id = ?', [
          request.id,
        ])
      )?.status,
    ).toBe('pending');

    const approval = requestDecisionApproval({
      requestId: request.id,
      requestTarget: request.target,
      decision: 'deny',
    });
    const d = await descriptor(approval);
    const decided = await call('POST', path, nick, { decision: 'deny', approval: proof(d) });
    expect(decided.status).toBe(200);
    expect(decided.json.decision).toBe('deny');
  });
});
