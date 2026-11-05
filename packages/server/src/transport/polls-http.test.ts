import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { enrollDeviceKey } from '../store/authority.js';
import { getMemberByName } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/**
 * Twitch polls over HTTP (ADR 807): only a human admin with a passkey opens a poll, only while
 * Twitch shows the channel live, one at a time; only the broadcast seat gets the poll token; and
 * the counts route takes integers on that token and nothing else.
 */
withDrivers('polls-http (ADR 807)', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let nick: string;
  let ada: AgentHttpAuth;
  let stream: string;
  let keyId: string;
  let signWith: (d: ApprovalDescriptor) => string;
  const SPEC = {
    question: 'What should revive work on next?',
    options: ['Camera', 'Ask the team'],
    minutes: 5,
  };

  async function call(method: string, path: string, auth: string | AgentHttpAuth, body?: unknown) {
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
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  async function signed(act: string, target: string, payload: unknown) {
    const res = await call('POST', '/teams/dawn/authority/descriptors', nick, {
      act,
      target,
      payload,
    });
    expect(res.status).toBe(201);
    const d = res.json.descriptor as ApprovalDescriptor;
    return { key_id: keyId, nonce: d.nonce, signature: signWith(d) };
  }

  const open = async (spec = SPEC) =>
    call('POST', '/teams/dawn/polls', nick, {
      spec,
      approval: await signed('credential_mint', 'dawn', { action: 'poll_open', spec }),
    });

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
    const team = await call('POST', '/teams', '', {
      slug: 'dawn',
      creator: { name: 'nick', kind: 'human' },
    });
    nick = team.json.human_credential;
    await call('POST', '/teams/dawn/members', nick, { name: 'ada', kind: 'agent' });
    ada = await claimAgentHttp(base, 'dawn', team.json.agent_key, nick, 'ada');
    const teamRow = (await getTeamBySlug(server.store, 'dawn'))!;
    const nickRow = (await getMemberByName(server.store, teamRow.id, 'nick'))!;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    signWith = (d) =>
      cryptoSign(null, Buffer.from(descriptorSigningBytes(d), 'utf8'), privateKey).toString(
        'base64url',
      );
    keyId = (
      await enrollDeviceKey(server.store, {
        teamId: teamRow.id,
        memberId: nickRow.id,
        publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        kind: 'platform',
      })
    ).id;
    // The stream's broadcast observer seat, minted the way `musterd broadcast` mints it.
    const seat = {
      name: 'broadcast-t1',
      kind: 'human',
      observer: true,
      observer_scope: 'broadcast',
    };
    const minted = await call('POST', '/teams/dawn/members', nick, {
      ...seat,
      approval: await signed('admin.roster', seat.name, {
        name: seat.name,
        kind: 'human',
        role: null,
        observer: true,
      }),
    });
    expect(minted.status).toBe(201);
    stream = minted.json.human_credential;
  });

  afterEach(async () => {
    await server.close();
  });

  const live = (v = true, as: string | AgentHttpAuth = stream) =>
    call('POST', '/teams/dawn/stream/live', as, { live: v });

  it('only the broadcast seat reports the stream live', async () => {
    expect((await live(true, nick)).status).toBe(403);
    expect((await live(true, ada)).status).toBe(403);
    expect((await live(true)).status).toBe(202);
    expect((await call('GET', '/teams/dawn/polls/open', nick)).json).toEqual({
      live: true,
      poll: null,
    });
  });

  it('refuses an agent, a missing signature, and a closed stream', async () => {
    await live();
    expect((await call('POST', '/teams/dawn/polls', ada, { spec: SPEC })).status).toBe(403);
    const unsigned = await call('POST', '/teams/dawn/polls', nick, { spec: SPEC });
    expect(unsigned.status).toBe(403);
    expect(JSON.stringify(unsigned.json)).toContain('no_signature');
    await live(false);
    const off = await open();
    expect(off.status).toBe(409);
    expect(JSON.stringify(off.json)).toContain('not live');
  });

  it('opens one poll, hands its token to the broadcast seat alone, and takes integer counts', async () => {
    await live();
    const opened = await open();
    expect(opened.status).toBe(201);
    const id = opened.json.poll.id as string;
    expect(opened.json.poll).not.toHaveProperty('poll_token');
    expect((await open()).status).toBe(409);

    expect((await call('GET', '/teams/dawn/polls/open', nick)).json.poll).not.toHaveProperty(
      'poll_token',
    );
    const read = await call('GET', '/teams/dawn/polls/open', stream);
    const token = read.json.poll.poll_token as string;
    expect(token).toMatch(/^mspoll_/);

    const report = { poll_id: id, counts: [2, 1], voters: 3, live: true, post_failed: false };
    expect(
      (
        await call('POST', `/teams/dawn/polls/${id}/counts`, token, {
          ...report,
          viewer: 'pixelpanda',
        })
      ).status,
    ).toBe(400);
    expect((await call('POST', `/teams/dawn/polls/${id}/counts`, nick, report)).status).toBe(401);
    expect((await call('POST', `/teams/dawn/polls/${id}/counts`, token, report)).status).toBe(202);
    expect((await call('GET', '/teams/dawn/polls/open', nick)).json.poll.counts).toEqual([2, 1]);

    const ended = await call('POST', `/teams/dawn/polls/${id}/end`, nick);
    expect(ended.status).toBe(200);
    expect(ended.json.poll).toMatchObject({
      state: 'closed',
      end: 'ended',
      winners: [0],
      voters: 3,
    });
    expect((await call('POST', `/teams/dawn/polls/${id}/counts`, token, report)).status).toBe(409);
  });

  it('records the poll as two daemon acts: a message that opens it, a resolve that closes it', async () => {
    await live();
    const id = (await open()).json.poll.id as string;
    expect((await call('POST', `/teams/dawn/polls/${id}/cancel`, ada)).status).toBe(403);
    expect((await call('POST', `/teams/dawn/polls/${id}/cancel`, nick)).status).toBe(200);
    const rows = await server.store.all<{
      act: string;
      meta: string;
      thread_id: string | null;
      id: string;
    }>(
      'SELECT id, act, meta, thread_id FROM messages WHERE meta LIKE \'%"poll"%\' ORDER BY created_at',
    );
    expect(rows.map((r) => [r.act, (JSON.parse(r.meta) as any).poll.state])).toEqual([
      ['message', 'open'],
      ['resolve', 'closed'],
    ]);
    expect(rows[1]!.thread_id).toBe(rows[0]!.id);
    expect((JSON.parse(rows[1]!.meta) as any).poll).toMatchObject({
      end: 'cancelled',
      winners: [],
    });
  });
});

withDrivers('polls-http (ADR 807) — no enrolled passkey', (_o, kind) => {
  it('refuses an admin who has no passkey enrolled: bearer_unenrolled cannot open a poll', async () => {
    const server = createServer({ db: await openTestDriver(kind), port: 0 });
    const base = `http://127.0.0.1:${(await server.listen()).port}`;
    try {
      const team = await fetch(base + '/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dusk', creator: { name: 'nick', kind: 'human' } }),
      }).then((r) => r.json() as Promise<any>);
      const res = await fetch(base + '/teams/dusk/polls', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${team.human_credential}`,
        },
        body: JSON.stringify({ spec: { question: 'Q?', options: ['a', 'b'] } }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('poll needs a passkey');
    } finally {
      await server.close();
    }
  });
});
