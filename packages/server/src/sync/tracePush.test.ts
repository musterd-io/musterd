import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope, type TraceEvent } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState, saveNodeEnrollment } from '../node/state.js';
import { addMember } from '../store/members.js';
import { insertMessage, localNodeForTeam } from '../store/messages.js';
import { bindSeatToNode } from '../store/nodes.js';
import { getTeamBySlug } from '../store/teams.js';
import { ingestTraceEvents, listSessionTrace, readSyncTraceCursor } from '../store/trace.js';
import { Hub } from '../transport/hub.js';
import { pushTeam } from './push.js';
import { pushTraceTeam } from './tracePush.js';

withDrivers('tracePush', (_o, kind) => {
  /**
   * ADR 453: a joiner's structural trace rows reach the hub's trace.db over /sync/trace, between two
   * real daemons. The properties under test are the ADR's: nothing lands in musterd.db, content
   * cannot cross, residence is judged per row, the cursor moves only on a 200, and the channel is
   * independent of the coordination push.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickCredential: string;
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

  const hubTeam = async () => (await getTeamBySlug(hub.store, 'bravo'))!;
  const joinerTeam = async () => (await getTeamBySlug(joiner.store, 'bravo'))!;
  const memberId = async (server: RunningServer, name: string) =>
    (await server.store.get('SELECT id FROM members WHERE team_id = ? AND name = ?', [
      (await getTeamBySlug(server.store, 'bravo'))!.id,
      name,
    ]))!.id;

  const ev = (over: Partial<TraceEvent> = {}): TraceEvent => ({
    harness: 'claude-code',
    session_digest: 'abcdef012345',
    ts: 1_790_000_000_000,
    kind: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01RAW',
    detail: { tool_input_bytes: 12 },
    ...over,
  });

  /** Record trace rows on the joiner as its seat `nick` (the tap's path, minus HTTP). */
  async function trace(seat: string, events: TraceEvent[], content = false) {
    return await ingestTraceEvents(joiner.traceStore, (await joinerTeam()).id, seat, events, {
      writeContent: content,
    });
  }

  /** A coordination message on the joiner, so /sync/push has something to bind nick with. */
  async function send(id: string) {
    const team = await joinerTeam();
    await insertMessage(
      joiner.store,
      team.id,
      await memberId(joiner, 'nick'),
      null,
      makeEnvelope({
        id,
        team: 'bravo',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: 'hi',
        ts: 1000,
      }),
    );
  }

  async function enrollJoiner() {
    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'joiner' },
      nickCredential,
    );
    const res = await post(joinerBase, '/node/enroll', {
      hub_url: hubBase,
      code: minted.invite,
      team: 'bravo',
    });
    expect(res.status).toBe(200);
  }

  const hubRows = async () =>
    await hub.traceStore.all(
      'SELECT seat, origin_node, tool_use_id, content FROM trace_events ORDER BY id',
    );
  const hubMusterdRows = async () => ({
    sync_log: (await hub.store.get('SELECT COUNT(*) AS n FROM sync_log'))!.n,
    audit: (await hub.store.get('SELECT COUNT(*) AS n FROM audit WHERE action LIKE ?', [
      '%trace%' as any,
    ]))!.n,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-tracepush-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
    hub = createServer({
      db: await openTestDriver(kind),
      traceDb: await openTestDriver(kind, { store: 'trace' }),
      port: 0,
    });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({
      db: await openTestDriver(kind, { instance: 'b' }),
      traceDb: await openTestDriver(kind, { store: 'trace', instance: 'b' }),
      port: 0,
    });
    joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
    joinerCtx = {
      db: joiner.store,
      traceDb: joiner.traceStore,
      hub: new Hub(),
      config: resolveConfig(),
      rosterRoots: [],
    } as Ctx;
    const created = await post(hubBase, '/teams', {
      slug: 'bravo',
      creator: { name: 'nick', kind: 'human' },
    });
    nickCredential = created.json.human_credential;
    await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } });
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe('/sync/trace — structural rows, joiner → hub (ADR 453)', async () => {
    it('does nothing before enrollment, and nothing on the hub for its own rows', async () => {
      await trace('nick', [ev()]);
      expect(await pushTraceTeam(joinerCtx, await joinerTeam())).toBeNull();
      // the hub holds joiners' rows and forwards none: its own rows are never offered
      await ingestTraceEvents(hub.traceStore, (await hubTeam()).id, 'nick', [ev()]);
      const hubCtx = {
        db: hub.store,
        traceDb: hub.traceStore,
        hub: new Hub(),
        config: resolveConfig(),
        rosterRoots: [],
      } as Ctx;
      expect(await pushTraceTeam(hubCtx, await hubTeam())).toBeNull();
    });

    it('pushes rows into the hub trace.db with origin_node and digested ids; musterd.db gains nothing', async () => {
      await send('m-1');
      await enrollJoiner();
      await pushTeam(joinerCtx, await joinerTeam()); // binds nick to the joiner the ordinary way
      const before = await hubMusterdRows();
      await trace(
        'nick',
        [
          ev(),
          ev({
            kind: 'usage',
            tool_use_id: 'toolu_01RAW',
            detail: { parser: 'claude-code@1', model: 'claude-opus-5-5', input_tokens: 3 },
          }),
        ],
        true,
      );

      const out = await pushTraceTeam(joinerCtx, await joinerTeam());
      expect(out).toMatchObject({ pushed: 2, ignored: 0, collided: 0, refused: 0 });

      const rows = await hubRows();
      expect(rows).toHaveLength(2);
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      expect(rows.every((r) => r.origin_node === joinerNode && r.seat === 'nick')).toBe(true);
      // ids cross as digests, never raw — and the R1↔R2 join still holds inside the release
      expect(rows[0]!.tool_use_id).toMatch(/^[0-9a-f]{24}$/);
      expect(rows[0]!.tool_use_id).toBe(rows[1]!.tool_use_id);
      expect(rows[0]!.tool_use_id).not.toBe('toolu_01RAW');
      // content never crosses, whatever the joiner stored
      expect(rows.every((r) => r.content === null)).toBe(true);
      // zero new bytes in the coordination store
      expect(await hubMusterdRows()).toEqual(before);
      // cursor moved to the last rowid
      expect(await readSyncTraceCursor(joiner.traceStore, (await joinerTeam()).id)).toBe(2);
    });

    it('a re-push is ignored, not duplicated; a digest collision under a new id is counted apart', async () => {
      await send('m-1');
      await enrollJoiner();
      await pushTeam(joinerCtx, await joinerTeam());
      await trace('nick', [ev()]);
      await pushTraceTeam(joinerCtx, await joinerTeam());
      // replay the same batch by resetting the cursor
      await joiner.traceStore.run(
        "UPDATE schema_meta SET value = '0' WHERE key LIKE 'sync_trace_cursor:%'",
      );
      expect(await pushTraceTeam(joinerCtx, await joinerTeam())).toMatchObject({
        pushed: 0,
        ignored: 1,
        collided: 0,
      });
      expect(await hubRows()).toHaveLength(1);
      // same (team, digest, seq) under a different id — a collision, never expected
      await joiner.traceStore.run("UPDATE trace_events SET id = '01J8ZK6Y3W6XQ2R9F4M2N7P8QA'");
      await joiner.traceStore.run(
        "UPDATE schema_meta SET value = '0' WHERE key LIKE 'sync_trace_cursor:%'",
      );
      expect(await pushTraceTeam(joinerCtx, await joinerTeam())).toMatchObject({
        pushed: 0,
        ignored: 0,
        collided: 1,
      });
    });

    it('a seat bound elsewhere is refused per row: batch-mates land, the cursor advances, no audit row', async () => {
      await send('m-1');
      await enrollJoiner();
      await pushTeam(joinerCtx, await joinerTeam());
      // hana lives on the hub; the joiner recorded a row of hers (a rebound seat's leftovers)
      await addMember(joiner.store, await joinerTeam(), { name: 'hana', kind: 'human' });
      await addMember(hub.store, await hubTeam(), { name: 'hana', kind: 'human' });
      await bindSeatToNode(
        hub.store,
        (await hubTeam()).id,
        await memberId(hub, 'hana'),
        (await localNodeForTeam(hub.store, (await hubTeam()).id)).id,
      );
      await trace('nick', [ev({ session_digest: 'aaaaaaaaaaaa' })]);
      await trace('hana', [ev({ session_digest: 'bbbbbbbbbbbb' })]);
      await trace('nick', [ev({ session_digest: 'cccccccccccc' })]);

      const auditBefore = (await hub.store.get('SELECT COUNT(*) AS n FROM audit'))!.n;
      expect(await pushTraceTeam(joinerCtx, await joinerTeam())).toMatchObject({
        pushed: 2,
        refused: 1,
      });
      expect((await hubRows()).map((r) => r.seat)).toEqual(['nick', 'nick']);
      expect(await readSyncTraceCursor(joiner.traceStore, (await joinerTeam()).id)).toBe(3);
      expect((await hub.store.get('SELECT COUNT(*) AS n FROM audit'))!.n).toBe(auditBefore);
      // hana's row is still on the joiner — nothing was lost locally
      expect(
        await listSessionTrace(joiner.traceStore, (await joinerTeam()).id, 'bbbbbbbbbbbb'),
      ).toHaveLength(1);
    });

    it('an unresolved or unbound seat holds the whole batch (409) and the cursor stays', async () => {
      await send('m-0'); // mints the local node row enrollment needs; NOT pushed, so nick stays unbound
      await enrollJoiner();
      // nick exists on the hub but no node has claimed her yet: unbound
      await trace('nick', [ev()]);
      expect(await pushTraceTeam(joinerCtx, await joinerTeam())).toMatchObject({ pushed: 0 });
      expect(await readSyncTraceCursor(joiner.traceStore, (await joinerTeam()).id)).toBe(0);
      expect(await hubRows()).toHaveLength(0);
      // a seat the hub's roster has not caught up to: unresolved
      await addMember(joiner.store, await joinerTeam(), { name: 'zed', kind: 'agent' });
      await trace('zed', [ev()]);
      expect(await pushTraceTeam(joinerCtx, await joinerTeam())).toMatchObject({ pushed: 0 });
      expect(await readSyncTraceCursor(joiner.traceStore, (await joinerTeam()).id)).toBe(0);
      // the trace surface never minted a binding for either
      expect((await hub.store.get('SELECT COUNT(*) AS n FROM seat_nodes'))!.n).toBe(0);
      // once nick binds the ordinary way, the same batch lands next tick
      await pushTeam(joinerCtx, await joinerTeam());
      await addMember(hub.store, await hubTeam(), { name: 'zed', kind: 'agent' });
      await bindSeatToNode(
        hub.store,
        (await hubTeam()).id,
        await memberId(hub, 'zed'),
        readNodeState().nodes['bravo']!.node_id,
      );
      expect(await pushTraceTeam(joinerCtx, await joinerTeam())).toMatchObject({ pushed: 2 });
    });

    it('a service seat (ADR 232) is resident everywhere: its rows are admitted from any node', async () => {
      await send('m-1');
      await enrollJoiner();
      await pushTeam(joinerCtx, await joinerTeam());
      await addMember(joiner.store, await joinerTeam(), {
        name: 'autorefresh',
        kind: 'service',
      });
      await addMember(hub.store, await hubTeam(), {
        name: 'autorefresh',
        kind: 'service',
      });
      await trace('autorefresh', [ev({ harness: 'codex', tool_name: 'Bash' })]);
      expect(await pushTraceTeam(joinerCtx, await joinerTeam())).toMatchObject({
        pushed: 1,
        refused: 0,
      });
    });

    it('the hub rejects a batch that is not structural — content, prose, a credential — and writes nothing', async () => {
      await send('m-1');
      await enrollJoiner();
      await pushTeam(joinerCtx, await joinerTeam());
      const cred = readNodeState().nodes['bravo']!.credential;
      const row = {
        id: '01J8ZK6Y3W6XQ2R9F4M2N7P8QA',
        seat: 'nick',
        session_digest: 'abcdef012345',
        seq: 0,
        ts: 1,
        received_at: 1,
        harness: 'claude-code',
        kind: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: null,
        agent_id: null,
        parent_agent_id: null,
        duration_ms: null,
        outcome: 'ok',
        detail: null,
      };
      for (const bad of [
        { ...row, content: { tool_input: 'ls' } },
        { ...row, tool_name: 'customer-project-summary' },
        { ...row, tool_name: 'mskey_' + 'A1b2C3d4'.repeat(6).slice(0, 43) },
        { ...row, tool_use_id: 'toolu_01RAW' },
        { ...row, detail: { note: 'see /Users/x/.env' } },
        { ...row, kind: 'usage', detail: { model: 'msgr_abc' } },
      ]) {
        const r = await post(hubBase, '/teams/bravo/sync/trace', { rows: [bad] }, cred);
        expect(r.status, JSON.stringify(bad)).toBe(400);
      }
      expect(await hubRows()).toHaveLength(0);
      // and a legitimate `other` passes
      const ok = await post(
        hubBase,
        '/teams/bravo/sync/trace',
        { rows: [{ ...row, tool_name: 'other' }] },
        cred,
      );
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({ accepted: 1, ignored: 0, collided: 0, refused: [] });
      // the pusher normalizes what the hub would reject, so a legacy row cannot wedge the cursor
      await trace('nick', [
        ev({ session_digest: 'dddddddddddd' }),
        ev({ session_digest: 'eeeeeeeeeeee' }),
      ]);
      await joiner.traceStore.run(
        `UPDATE trace_events SET tool_name = 'see this', detail = '{"note":"x","tool_input_bytes":12}'
          WHERE session_digest = 'dddddddddddd'`,
      );
      expect(await pushTraceTeam(joinerCtx, await joinerTeam())).toMatchObject({
        pushed: 2,
        normalized: 2,
      });
      expect((await hubRows()).map((r) => r.seat)).toEqual(['nick', 'nick', 'nick']);
    });

    it('refuses a caller without a machine credential', async () => {
      await send('m-0');
      await enrollJoiner();
      const r = await post(hubBase, '/teams/bravo/sync/trace', { rows: [] }, nickCredential);
      expect(r.status).toBe(401);
    });

    it('a stalled /sync/trace leaves /sync/push unaffected — the channels share no state', async () => {
      await send('m-1');
      await enrollJoiner();
      // A hub that answers /sync/push and hangs /sync/trace, in the joiner's node.json.
      const real = readNodeState().nodes['bravo']!;
      const hanging = createHttpServer(async (req, res) => {
        if (req.url?.endsWith('/sync/trace')) return; // never answers
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          void fetch(hubBase + req.url!, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${real.credential}`,
            },
            body,
          }).then(async (u) => {
            res.writeHead(u.status, { 'content-type': 'application/json' });
            res.end(await u.text());
          });
        });
      });
      const url = await new Promise<string>((resolve) =>
        hanging.listen(0, '127.0.0.1', () => {
          const a = hanging.address();
          resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
        }),
      );
      saveNodeEnrollment({ team: 'bravo', ...real, hub_url: url });
      await trace('nick', [ev()]);
      const traceCursor = await readSyncTraceCursor(joiner.traceStore, (await joinerTeam()).id);
      // the coordination push completes on its own while the trace push is still hanging
      const hung = pushTraceTeam(joinerCtx, await joinerTeam());
      expect(await pushTeam(joinerCtx, await joinerTeam())).toBe(1);
      // the trace push times out on its own AbortSignal; its cursor never moved
      await expect(hung).rejects.toThrow();
      expect(await readSyncTraceCursor(joiner.traceStore, (await joinerTeam()).id)).toBe(
        traceCursor,
      );
      hanging.closeAllConnections?.();
      await new Promise<void>((r) => hanging.close(() => r()));
    }, 20_000);
  });
});
