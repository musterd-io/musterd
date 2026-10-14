import { PROTOCOL_VERSION } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getTeamBySlug } from '../store/teams.js';

withDrivers('sync-http', (_o, kind) => {
  /**
   * The push route (ADR 325 increment 3b-i), at the boundary a real pusher actually crosses.
   *
   * Two properties these tests exist to hold. The surface is admitted by `msnode_` and by NOTHING
   * else — ADR 328 §3 keeps "a machine is admitted" and "a seat is authorized" independent axes, and
   * collapsing them would make one laptop's compromise a licence to act as a teammate. And every
   * refusal the store can raise has to arrive as a refusal the caller can act on: a 500 would read as
   * "the hub is broken" for what is actually "resend from seq N".
   */

  let server: RunningServer;
  let base: string;
  let nickCredential: string;
  let adaKey: string;

  type Auth = string | { key: string; seat: string };

  function headers(auth?: Auth): Record<string, string> {
    if (!auth) return {};
    if (typeof auth === 'string') return { authorization: `Bearer ${auth}` };
    return { authorization: `Bearer ${auth.key}`, 'x-musterd-seat': auth.seat };
  }

  async function request(method: string, path: string, body?: unknown, auth?: Auth) {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers(auth) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
  }

  /** Enroll a machine the way an operator does: admin mints an invite, the joiner trades it. */
  async function enroll(nodeId = 'node-remote'): Promise<string> {
    const minted = await request(
      'POST',
      '/teams/bravo/nodes/invite',
      { label: nodeId },
      nickCredential,
    );
    expect(minted.status).toBe(200);
    const joined = await request('POST', '/teams/bravo/nodes/join', {
      code: minted.json.invite,
      node_id: nodeId,
      label: nodeId,
    });
    expect(joined.status).toBe(200);
    return joined.json.node_credential as string;
  }

  async function ev(node: string, seq: number, id = `${node}-${seq}`) {
    return {
      envelope: {
        id,
        v: PROTOCOL_VERSION,
        team: 'bravo',
        from: 'ada',
        to: { kind: 'team' as const },
        act: 'message' as const,
        body: 'hi',
        ts: 1000 + seq,
      },
      origin_node: node,
      origin_seq: seq,
      from_provenance: null,
    };
  }

  const push = async (events: unknown[], auth?: Auth) =>
    await request('POST', '/teams/bravo/sync/push', { events }, auth);

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;

    const created = await request('POST', '/teams', {
      slug: 'bravo',
      creator: { name: 'nick', kind: 'human' },
    });
    nickCredential = created.json.human_credential;
    adaKey = created.json.agent_key;
    await request('POST', '/teams/bravo/members', { name: 'ada', kind: 'agent' }, nickCredential);
  });

  afterEach(async () => {
    await server.close();
  });

  describe('POST /teams/:slug/sync/push (ADR 325/328)', () => {
    it('accepts a batch from an enrolled node and reports the canonical head', async () => {
      const credential = await enroll();

      const res = await push([await ev('node-remote', 1), await ev('node-remote', 2)], credential);

      expect(res.status).toBe(200);
      // ADR 591: the hub says on every answer whether its fold is held — null when it is moving.
      expect(res.json).toEqual({ accepted: 2, hub_seq_high: 2, fold_stopped: null });
    });

    it('acks a replayed batch without staging it twice', async () => {
      const credential = await enroll();
      await push([await ev('node-remote', 1)], credential);

      // A lost ack is the realistic failure; the pusher resends. The hub must ack, not refuse.
      const replay = await push([await ev('node-remote', 1)], credential);
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual({ accepted: 0, hub_seq_high: 1, fold_stopped: null });
    });

    it('refuses a seat credential — msnode_ admits this surface, nothing else does', async () => {
      await enroll();
      const events = [await ev('node-remote', 1)];

      // An agent key with its seat header, and a human's team credential. Both are perfectly valid
      // credentials on their own axis (ADR 328 §3) and neither admits a machine to the sync surface.
      expect((await push(events, { key: adaKey, seat: 'ada' })).status).toBe(401);
      expect((await push(events, nickCredential)).status).toBe(401);
      expect((await push(events)).status).toBe(401);

      expect(await server.store.get('SELECT COUNT(*) AS n FROM sync_log')).toEqual({ n: 0 });
    });

    it('refuses a revoked node — revocation cuts push off immediately (§5)', async () => {
      const credential = await enroll();
      expect((await push([await ev('node-remote', 1)], credential)).status).toBe(200);

      await request('POST', '/teams/bravo/nodes/node-remote/revoke', undefined, nickCredential);

      expect((await push([await ev('node-remote', 2)], credential)).status).toBe(401);
      // Events already ingested stay — revocation stops the future, it does not rewrite the past.
      expect(await server.store.get('SELECT COUNT(*) AS n FROM sync_log')).toEqual({ n: 1 });
    });

    it("refuses a batch carrying another node's origin as a refusal, not a fault", async () => {
      const credential = await enroll('node-a');
      await enroll('node-b');

      const res = await push([await ev('node-b', 1)], credential);

      // 403, not 500: the store throws, and the route must map it. An unmapped throw would tell the
      // caller the hub is broken when what actually happened is that it declined.
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('forbidden');
      expect(await server.store.get('SELECT COUNT(*) AS n FROM sync_log')).toEqual({ n: 0 });
    });

    it('refuses a gap with the resume point in the body', async () => {
      const credential = await enroll();
      await push([await ev('node-remote', 1)], credential);

      const res = await push([await ev('node-remote', 3)], credential);

      expect(res.status).toBe(409);
      // A pusher that cannot self-correct retries the same rejected batch forever.
      expect(res.json.expected_seq).toBe(2);
      // And the envelope stays byte-compatible with ErrorBodySchema — a flat { error, message } was
      // the 3a bug that made every refusal render as a bare "server error (409)" in the CLI.
      expect(res.json.error).toEqual({ code: 'conflict', message: expect.any(String) });
    });

    it('bounds the batch at the wire schema rather than the database', async () => {
      const credential = await enroll();
      const events = await Promise.all(
        Array.from({ length: 501 }, (_, i) => ev('node-remote', i + 1)),
      );

      // An unbounded batch is an unauthenticated-adjacent memory primitive; the refusal belongs
      // before any of it is parsed into the log.
      expect((await push(events, credential)).status).toBe(400);
      expect(await server.store.get('SELECT COUNT(*) AS n FROM sync_log')).toEqual({ n: 0 });
    });

    it('leaves messages untouched', async () => {
      const credential = await enroll();
      await push([await ev('node-remote', 1), await ev('node-remote', 2)], credential);

      // The containment property, at the boundary a real pusher crosses: 3b-i stages, it never folds.
      expect(await server.store.get('SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 0 });
      const team = (await getTeamBySlug(server.store, 'bravo'))!;
      const seqs = await server.store.all('SELECT next_seq FROM nodes WHERE team_id = ?', [
        team.id,
      ]);
      // The enrolled node, and no other: this team has sent nothing locally, so its own row does not
      // exist yet. Every counter still reads 1 — ingest allocated none of them.
      expect(seqs.map((r) => r.next_seq)).toEqual([1]);
    });
  });
});
