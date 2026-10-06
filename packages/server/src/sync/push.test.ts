import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState, saveNodeEnrollment } from '../node/state.js';
import { addMember, mintCredential } from '../store/members.js';
import { insertMessage, localNodeForTeam } from '../store/messages.js';
import { bindSeatToNode, seatBinding } from '../store/nodes.js';
import { attach } from '../store/presence.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pushTeam, readPushRefusal, wedgeKind } from './push.js';

withDrivers('push', (_o, kind) => {
  /**
   * The daemon-side push loop (ADR 325 increment 3b-i), exercised between two real daemons.
   *
   * The property that matters is the cursor's: it advances only past a batch the hub ACKED. A cursor
   * that moved on send would turn every unreachable hub into permanent silent loss — the pusher would
   * believe it had delivered events that never arrived, and nothing downstream could tell that from a
   * team that simply said nothing. Offline is the expected state here, not the exceptional one.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickCredential: string;
  let nickOnJoinerCredential: string;
  const nickCredentialOnJoiner = () => nickOnJoinerCredential;
  let dir: string;
  /** The joiner's own context — pushTeam runs inside the joiner daemon, not the hub. */
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

  /** Send on the joiner, the way a live daemon mints its local node row and stamps an origin_seq. */
  async function send(server: RunningServer, id: string, body = 'hi') {
    const team = (await getTeamBySlug(server.store, 'bravo'))!;
    const member = await server.store.get('SELECT id FROM members WHERE team_id = ? LIMIT 1', [
      team.id,
    ])!;
    await insertMessage(
      server.store,
      team.id,
      member.id,
      null,
      makeEnvelope({
        id,
        team: 'bravo',
        from: 'nick',
        to: { kind: 'team' as const },
        act: 'message',
        body,
        ts: 1000,
      }),
    );
  }

  /** Enroll the joiner at the hub through the real ceremony, so node.json holds a live credential. */
  async function enrollJoiner() {
    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'joiner laptop' },
      nickCredential,
    );
    const res = await post(joinerBase, '/node/enroll', {
      hub_url: hubBase,
      code: minted.invite,
      team: 'bravo',
    });
    expect(res.status).toBe(200);
  }

  /** A hub that answers every push with one canned status+body — for the paths a real hub cannot reach. */
  function createHubStub(status: number, body: unknown) {
    const server = createHttpServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    const url = new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
      });
    });
    return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  /**
   * Run `fn` and collect the daemon's log lines, so a test can assert what an OPERATOR would see
   * rather than only what the caller catches.
   *
   * Vitest sets MUSTERD_SILENT=1 for the whole suite; it is lifted for the duration of the call
   * because the visibility of the line IS the property under test here (ADR 335 §7 decision 7).
   */
  async function captureLogs(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const lines: Record<string, unknown>[] = [];
    const record = (chunk: unknown): boolean => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not one of ours
        }
      }
      return true;
    };
    const silent = process.env['MUSTERD_SILENT'];
    const [outWrite, errWrite] = [process.stdout.write, process.stderr.write];
    delete process.env['MUSTERD_SILENT'];
    process.stdout.write = record as typeof process.stdout.write;
    process.stderr.write = record as typeof process.stderr.write;
    try {
      await fn().catch(() => undefined);
    } finally {
      process.stdout.write = outWrite;
      process.stderr.write = errWrite;
      if (silent !== undefined) process.env['MUSTERD_SILENT'] = silent;
    }
    return lines;
  }

  const joinerTeam = async () => (await getTeamBySlug(joiner.store, 'bravo'))!;
  const stagedOnHub = async () => await hub.store.get('SELECT COUNT(*) AS n FROM sync_log');
  const cursor = async () =>
    (
      await joiner.store.get('SELECT last_seq FROM sync_push_cursor WHERE team_id = ?', [
        (await joinerTeam()).id,
      ])
    )?.last_seq ?? 0;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-push-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

    hub = createServer({ db: await openTestDriver(kind), port: 0 });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({ db: await openTestDriver(kind, { instance: 'b' }), port: 0 });
    joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
    joinerCtx = {
      db: joiner.store,
      hub: new Hub(),
      config: resolveConfig(),
      rosterRoots: [],
    };

    // The same team on both daemons — roster identity replicates via git (ADR 058), so this is what
    // two machines hosting one team actually look like.
    const created = await post(hubBase, '/teams', {
      slug: 'bravo',
      creator: { name: 'nick', kind: 'human' },
    });
    nickCredential = created.json.human_credential;
    const onJoiner = await post(joinerBase, '/teams', {
      slug: 'bravo',
      creator: { name: 'nick', kind: 'human' },
    });
    nickOnJoinerCredential = onJoiner.json.human_credential;
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the push loop', () => {
    it("pushes this node's unpushed messages and advances the cursor", async () => {
      await send(joiner, 'm-1');
      await send(joiner, 'm-2');
      await enrollJoiner();

      expect(await pushTeam(joinerCtx, await joinerTeam())).toBe(2);

      expect(await stagedOnHub()).toEqual({ n: 2 });
      expect(await cursor()).toBe(2);
      // The wire carries the seat NAME, never `from_member`: a daemon-private id would dangle on the
      // receiver, or resolve to a DIFFERENT seat holding that id there (ADR 325).
      const staged = await hub.store.all('SELECT payload FROM sync_log ORDER BY hub_seq');
      expect(JSON.parse(staged[0]!.payload).envelope.from).toBe('nick');
      expect(staged[0]!.payload).not.toContain('from_member');
    });

    it('advances the cursor only past an ACKED batch', async () => {
      await send(joiner, 'm-1');
      await enrollJoiner();
      // Repoint the enrollment at a port nothing is listening on: the hub is unreachable, which is
      // an ordinary Tuesday for a laptop, not a fault.
      const enrolled = readNodeState().nodes['bravo']!;
      saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: 'http://127.0.0.1:1' });

      // The pass surfaces the failure rather than swallowing it — the loop is what treats offline as
      // expected (`sync_push_failed`, retry next tick), which is the shape seeds/ingest.ts uses. A
      // pass that returned 0 here would make a permanently misconfigured hub_url indistinguishable
      // from having nothing to send.
      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow();

      // And the important half: a cursor that moved on SEND rather than on ACK would make this
      // permanent silent loss. It did not move, so the next tick resends.
      expect(await cursor()).toBe(0);
      expect(await stagedOnHub()).toEqual({ n: 0 });
    });

    it('re-sends after a lost ack without duplicating on the hub', async () => {
      await send(joiner, 'm-1');
      await enrollJoiner();
      await pushTeam(joinerCtx, await joinerTeam());
      expect(await stagedOnHub()).toEqual({ n: 1 });

      // The ack was lost in flight: the hub holds the event, the pusher does not know it. Rewinding
      // the cursor is exactly what that looks like on the next tick.
      await joiner.store.run('UPDATE sync_push_cursor SET last_seq = 0');
      const accepted = await pushTeam(joinerCtx, await joinerTeam());

      // Idempotence end to end: the hub acks without staging a second copy, and the cursor recovers.
      expect(accepted).toBe(0);
      expect(await stagedOnHub()).toEqual({ n: 1 });
      expect(await cursor()).toBe(1);
    });

    it('refuses a resume point ahead of anything this node has ever minted', async () => {
      await send(joiner, 'm-1');
      await send(joiner, 'm-2');
      await send(joiner, 'm-3');
      await enrollJoiner();

      // A hub answering with a seq we never minted is asserting something impossible, not correcting
      // us. dolly, 2026-08-28 (#1102 required B): validated only as an integer >= 1, expected_seq
      // 1000000 drove the cursor to 999999 and every later pass sent nothing — the silent loss the
      // cursor exists to prevent, reintroduced through the one number the hub gets to dictate.
      const enrolled = readNodeState().nodes['bravo']!;
      const stub = createHubStub(409, {
        error: { code: 'conflict', message: 'gap' },
        expected_seq: 1000000,
      });
      saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: await stub.url });

      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/impossible|ahead/i);

      // The cursor did not move, so the three messages are still queued for a hub that tells the truth.
      expect(await cursor()).toBe(0);
      await stub.close();
    });

    it('accepts a resume point at or below this node\u2019s head', async () => {
      await send(joiner, 'm-1');
      await send(joiner, 'm-2');
      await enrollJoiner();

      // head + 1 EXACTLY — the boundary, and the case a too-tight clamp would break: the hub holds
      // everything we have minted (1 and 2) and asks for the next seq we have not written yet. Tested
      // at the boundary on purpose; asserting at `head` would pass under an off-by-one clamp too.
      const enrolled = readNodeState().nodes['bravo']!;
      const stub = createHubStub(409, {
        error: { code: 'conflict', message: 'gap' },
        expected_seq: 3,
      });
      saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: await stub.url });

      expect(await pushTeam(joinerCtx, await joinerTeam())).toBe(0);
      expect(await cursor()).toBe(2);
      await stub.close();
    });

    it('reports a terminal refusal at error rather than retrying it as if offline', async () => {
      await send(joiner, 'm-1');
      await enrollJoiner();
      // A 422 is a batch the hub will never accept. The loop's every other answer is "retry next
      // tick", which here means resending a poison batch forever behind a line that reads as offline.
      const stub = createHubStub(422, {
        error: { code: 'validation', message: 'duplicate id' },
        event_id: 'm-1',
        terminal: true,
      });
      const enrolled = readNodeState().nodes['bravo']!;
      saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: await stub.url });

      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/permanently refused/i);
      expect(await cursor()).toBe(0);
      await stub.close();
    });

    it('refuses a resume point just one past the boundary, not only an absurd one', async () => {
      await send(joiner, 'm-1');
      await send(joiner, 'm-2');
      await enrollJoiner();

      // head is 2, so head + 1 = 3 is legitimate and head + 2 = 4 is not. Tested at 4 rather than at
      // an absurd 1000000 because only the adjacent value pins the ceiling: a head read one too high
      // accepts 4 and every far-away assertion still passes. That mutation survived once.
      const enrolled = readNodeState().nodes['bravo']!;
      const stub = createHubStub(409, {
        error: { code: 'conflict', message: 'gap' },
        expected_seq: 4,
      });
      saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: await stub.url });

      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/impossible|ahead/i);
      expect(await cursor()).toBe(0);
      await stub.close();
    });

    it('distinguishes an impossible resume point from being offline', async () => {
      await send(joiner, 'm-1');
      await send(joiner, 'm-2');
      await enrollJoiner();

      // The refusal above is right and, until this line existed, invisible: startSyncPush catches it
      // into log.warn sync_push_failed, the same line a laptop on a train writes every 60s forever.
      // On the branch that guards against SILENT DATA LOSS, that is the one case where an operator
      // most needs a signal saying nothing that reads like one (dolly, 2026-08-31, #1102 re-review).
      const enrolled = readNodeState().nodes['bravo']!;
      const stub = createHubStub(409, {
        error: { code: 'conflict', message: 'gap' },
        expected_seq: 4,
      });
      saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: await stub.url });

      const lines = await captureLogs(async () => await pushTeam(joinerCtx, await joinerTeam()));

      // Both numbers, because either alone leaves the reader unable to tell which side is wrong.
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 'error',
          msg: 'sync_push_impossible_resume',
          resume_at: 4,
          head: 2,
        }),
      );
      expect(await cursor()).toBe(0);
      await stub.close();
    });

    it('distinguishes a 409 with no usable resume point at all from being offline', async () => {
      await send(joiner, 'm-1');
      await enrollJoiner();

      // Same throw-into-the-offline-line defect on the other 409 exit. `expected_seq` is present and
      // unusable here rather than missing, because that is the shape a miscomputing hub produces and
      // the value the operator needs echoed back.
      const enrolled = readNodeState().nodes['bravo']!;
      const stub = createHubStub(409, {
        error: { code: 'conflict', message: 'gap' },
        expected_seq: 0,
      });
      saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: await stub.url });

      const lines = await captureLogs(async () => await pushTeam(joinerCtx, await joinerTeam()));

      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 'error',
          msg: 'sync_push_no_resume_point',
          resume_at: 0,
          head: 1,
        }),
      );
      expect(await cursor()).toBe(0);
      await stub.close();
    });

    it('does nothing for a team with no enrollment', async () => {
      await send(joiner, 'm-1');

      // The single-machine case, which is every musterd install today: no node.json entry, so no
      // outbound call at all. Not an error — most teams are never federated.
      expect(await pushTeam(joinerCtx, await joinerTeam())).toBe(0);
      expect(await cursor()).toBe(0);
      expect(await stagedOnHub()).toEqual({ n: 0 });
    });

    it('does nothing when the daemon has never sent for the team', async () => {
      await post(joinerBase, '/teams', { slug: 'quiet', creator: { name: 'nick', kind: 'human' } });
      // Enrolled, but with no local row — node.json is keyed by SLUG while the db keys by team_id, so
      // a renamed team, a restored database, or a hand-edited file all reach exactly this state.
      await send(joiner, 'm-1');
      await enrollJoiner();
      const enrolled = readNodeState().nodes['bravo']!;
      saveNodeEnrollment({ team: 'quiet', ...enrolled });

      // No local_node row: this daemon has stamped no origin, so it has nothing of its own to push
      // and must not mint an identity just to discover that. Reading `local_node` is what keeps that
      // true — the minting path (insertMessage's localNodeForTeam) would create a row and a marker.
      const quiet = (await getTeamBySlug(joiner.store, 'quiet'))!;
      expect(await pushTeam(joinerCtx, quiet)).toBe(0);

      const rows = async (t: string) =>
        (await joiner.store.get(`SELECT COUNT(*) AS n FROM ${t} WHERE team_id = ?`, [quiet.id]))!.n;
      expect(await rows('nodes')).toBe(0);
      expect(await rows('local_node')).toBe(0);
    });

    it('pushes only this node’s own events, never a peer’s', async () => {
      await send(joiner, 'm-1');
      await enrollJoiner();
      // A foreign origin sitting in the local log — what 3b-ii's fold will one day put there. This
      // node may push only its own events, so the batch must not sweep it up.
      const team = await joinerTeam();
      await joiner.store.run(
        'INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)',
        ['node-peer', team.id, 'peer'],
      );
      await joiner.store.run(
        `INSERT INTO messages (id, team_id, from_member, to_kind, act, body, ts, created_at,
                               origin_node, origin_seq)
         SELECT 'm-peer', team_id, from_member, to_kind, act, body, 2000, 2000, 'node-peer', 1
           FROM messages LIMIT 1`,
      );

      expect(await pushTeam(joinerCtx, team)).toBe(1);

      const origins = await hub.store.all('SELECT DISTINCT origin_node FROM sync_log');
      expect(origins).toHaveLength(1);
      expect(origins[0]!.origin_node).not.toBe('node-peer');
    });
  });

  describe('the hub pushes to itself (3b-ii loopback)', () => {
    const hubCtx = () => ({
      db: hub.store,
      hub: new Hub(),
      config: resolveConfig(),
      rosterRoots: [],
    });
    const hubStaged = async () =>
      await hub.store.all('SELECT origin_node, origin_seq, hub_seq FROM sync_log ORDER BY hub_seq');

    it('stages nothing while the team has no enrolled joiner (single-machine install)', async () => {
      await send(hub, 'h-1');
      expect(await pushTeam(hubCtx(), await (await getTeamBySlug(hub.store, 'bravo'))!)).toBe(0);
      expect(await hubStaged()).toEqual([]);
    });

    it('stages its own history through ingestBatch once a joiner is enrolled, dense hub_seq', async () => {
      await send(hub, 'h-1');
      await send(hub, 'h-2');
      // The joiner needs its own node row before it can enroll (minted on its first logged act).
      await send(joiner, 'j-0');
      await enrollJoiner();
      const team = (await getTeamBySlug(hub.store, 'bravo'))!;
      expect(await pushTeam(hubCtx(), team)).toBe(2);
      const local = (await hub.store.get('SELECT node_id FROM local_node WHERE team_id = ?', [
        team.id,
      ]))!.node_id;
      expect(await hubStaged()).toEqual([
        { origin_node: local, origin_seq: 1, hub_seq: 1 },
        { origin_node: local, origin_seq: 2, hub_seq: 2 },
      ]);
      // Idempotent: a second pass stages nothing new and the cursor holds.
      expect(await pushTeam(hubCtx(), team)).toBe(0);
      // And the hub's own messages table is untouched by staging (containment still holds).
      expect(await hub.store.get('SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 2 });
    });
  });

  describe("push-level residence — every kind, not only presence (ADR 355 §5's named next increment, 2026-09-02)", async () => {
    const hubTeam = async () => (await getTeamBySlug(hub.store, 'bravo'))!;
    const memberId = async (server: RunningServer, name: string) =>
      (await server.store.get('SELECT id FROM members WHERE team_id = ? AND name = ?', [
        (await getTeamBySlug(server.store, 'bravo'))!.id,
        name,
      ]))!.id;

    it('a MESSAGE from a seat bound to another node is refused whole; the cursor does not move', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      const hubNode = await localNodeForTeam(hub.store, (await hubTeam()).id);
      await bindSeatToNode(
        hub.store,
        (await hubTeam()).id,
        await memberId(hub, 'nick'),
        hubNode.id,
      );
      const cursorBefore = await cursor();
      const lines = await captureLogs(async () => await pushTeam(joinerCtx, await joinerTeam()));
      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/bound_elsewhere|403/);
      expect(await cursor()).toBe(cursorBefore);
      expect(await stagedOnHub()).toEqual({ n: 0 });
      expect(
        lines.some((l) => l['msg'] === 'sync_push_refused_residence' && l['seat'] === 'nick'),
      ).toBe(true);
    });

    it('a LANE transition naming a seat bound elsewhere is refused, and the rollback binds nobody from the same batch', async () => {
      await send(joiner, 'j-0'); // nick, unbound anywhere
      await enrollJoiner();
      const hanaOnJoiner = (
        await mintCredential(
          joiner.store,
          (
            await addMember(joiner.store, await joinerTeam(), {
              name: 'hana',
              kind: 'human',
            })
          ).row.id,
        )
      ).credential;
      await addMember(hub.store, await hubTeam(), { name: 'hana', kind: 'human' });
      const hubNode = await localNodeForTeam(hub.store, (await hubTeam()).id);
      await bindSeatToNode(
        hub.store,
        (await hubTeam()).id,
        await memberId(hub, 'hana'),
        hubNode.id,
      );
      // hana opens a lane on the joiner: a lane.opened row with hana as its actor, behind nick's message.
      const opened = await post(joinerBase, '/teams/bravo/lanes', { title: 'x' }, hanaOnJoiner);
      expect(opened.status).toBe(201);
      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/bound_elsewhere|403/);
      expect(await stagedOnHub()).toEqual({ n: 0 });
      // The message before the refused lane row would have bound nick to the joiner; the batch rolled
      // back, so it did not.
      expect(await seatBinding(hub.store, await memberId(hub, 'nick'))).toBeUndefined();
    });

    it('a first message binds an unbound seat to the pusher, the way a first presence does', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      await pushTeam(joinerCtx, await joinerTeam());
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      expect((await seatBinding(hub.store, await memberId(hub, 'nick')))?.node_id).toBe(joinerNode);
    });

    it('a service seat (ADR 232) is resident everywhere: its events are accepted from any node and bind nothing', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      const svcOnJoiner = (
        await addMember(joiner.store, await joinerTeam(), {
          name: 'autorefresh',
          kind: 'service',
        })
      ).row;
      await addMember(hub.store, await hubTeam(), {
        name: 'autorefresh',
        kind: 'service',
      });
      const hubNode = await localNodeForTeam(hub.store, (await hubTeam()).id);
      // The hub's own autorefresh has spoken there first — an ordinary two-machine install.
      await bindSeatToNode(
        hub.store,
        (await hubTeam()).id,
        await memberId(hub, 'autorefresh'),
        hubNode.id,
      );
      await insertMessage(
        joiner.store,
        (await joinerTeam()).id,
        svcOnJoiner.id,
        null,
        makeEnvelope({
          id: 'svc-1',
          team: 'bravo',
          from: 'autorefresh',
          to: { kind: 'team' as const },
          act: 'status_update',
          body: 'bounced the daemon on the joiner',
          ts: 1001,
        }),
      );
      await expect(pushTeam(joinerCtx, await joinerTeam())).resolves.toBe(2);
      expect((await seatBinding(hub.store, await memberId(hub, 'autorefresh')))?.node_id).toBe(
        hubNode.id,
      );
      expect(
        await hub.store.get('SELECT COUNT(*) AS n FROM seat_nodes WHERE member_id = ?', [
          await memberId(hub, 'autorefresh'),
        ]),
      ).toEqual({ n: 1 });
    });
  });

  describe('a wedged push says so where the seat is (ADR 360 follow-on)', async () => {
    const hubTeam = async () => (await getTeamBySlug(hub.store, 'bravo'))!;
    const memberId = async (server: RunningServer, name: string) =>
      (await server.store.get('SELECT id FROM members WHERE team_id = ? AND name = ?', [
        (await getTeamBySlug(server.store, 'bravo'))!.id,
        name,
      ]))!.id;
    async function get(base: string, path: string, auth: string) {
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${auth}` } });
      return { status: response.status, json: (await response.json()) as any };
    }

    it('the refusal persists on the cursor row, names the seat, the bound node and the kind, keeps its first-seen clock, and rides the roster and node list', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      const hubNode = await localNodeForTeam(hub.store, (await hubTeam()).id);
      await bindSeatToNode(
        hub.store,
        (await hubTeam()).id,
        await memberId(hub, 'nick'),
        hubNode.id,
      );
      expect(await readPushRefusal(joiner.store, (await joinerTeam()).id)).toBeNull();

      await expect(pushTeam(joinerCtx, await joinerTeam(), 1000)).rejects.toThrow(
        /bound_elsewhere|403/,
      );
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      const wedge = await readPushRefusal(joiner.store, (await joinerTeam()).id);
      expect(wedge).toMatchObject({
        seat: 'nick',
        bound_node_id: hubNode.id,
        node_id: joinerNode,
        kind: 'message',
        since: 1000,
      });
      // A repeat refusal every tick does not restart the clock.
      await expect(pushTeam(joinerCtx, await joinerTeam(), 61_000)).rejects.toThrow(/403/);
      expect((await readPushRefusal(joiner.store, (await joinerTeam()).id))?.since).toBe(1000);

      // The joiner's roster — what every seat session on this machine reads — carries it.
      const roster = await get(joinerBase, '/teams/bravo/members', nickCredentialOnJoiner());
      expect(roster.status).toBe(200);
      expect(roster.json.sync.wedged).toMatchObject({ seat: 'nick', node_id: joinerNode });
      const nodes = await get(joinerBase, '/teams/bravo/nodes', nickCredentialOnJoiner());
      expect(nodes.json.push.wedged).toMatchObject({ seat: 'nick' });
      // The hub's own roster says nothing — its push is not wedged.
      const hubRoster = await get(hubBase, '/teams/bravo/members', nickCredential);
      expect(hubRoster.json.sync.wedged).toBeNull();
    });

    it('the wedge clears on the next accepted push', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      const hubNode = await localNodeForTeam(hub.store, (await hubTeam()).id);
      await bindSeatToNode(
        hub.store,
        (await hubTeam()).id,
        await memberId(hub, 'nick'),
        hubNode.id,
      );
      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/403/);
      expect(await readPushRefusal(joiner.store, (await joinerTeam()).id)).not.toBeNull();
      // The remedy: the seat moves (an admin unbind here), and the same batch goes through.
      const { unbindSeat } = await import('../store/nodes.js');
      await unbindSeat(hub.store, await memberId(hub, 'nick'));
      await expect(pushTeam(joinerCtx, await joinerTeam())).resolves.toBeGreaterThan(0);
      expect(await readPushRefusal(joiner.store, (await joinerTeam()).id)).toBeNull();
      const roster = await get(joinerBase, '/teams/bravo/members', nickCredentialOnJoiner());
      expect(roster.json.sync.wedged).toBeNull();
    });
  });

  describe('presence replication on the push (spec 2026-09-02)', async () => {
    const hubTeam = async () => (await getTeamBySlug(hub.store, 'bravo'))!;
    const memberId = async (server: RunningServer, name: string) =>
      (await server.store.get('SELECT id FROM members WHERE team_id = ? AND name = ?', [
        (await getTeamBySlug(server.store, 'bravo'))!.id,
        name,
      ]))!.id;

    it('a presence.* row rides the push under kind presence, and the hub stamps the node as seen', async () => {
      await send(joiner, 'j-0'); // mints the joiner's node row; enrollment needs it
      await enrollJoiner();
      await addMember(joiner.store, await joinerTeam(), { name: 'ada', kind: 'agent' });
      await addMember(hub.store, await hubTeam(), { name: 'ada', kind: 'agent' });
      await attach(joiner.store, await memberId(joiner, 'ada'), 'codex', 'c1', {
        model: 'gpt-5',
      });
      const before = Date.now();
      await pushTeam(joinerCtx, await joinerTeam(), before);
      const staged = (await hub.store.all('SELECT payload FROM sync_log ORDER BY hub_seq')).map(
        (r) => JSON.parse(r.payload),
      );
      expect(
        staged.some((e) => e.kind === 'presence' && e.event.action === 'presence.attached'),
      ).toBe(true);
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      expect(
        (await hub.store.get('SELECT last_seen_at FROM nodes WHERE id = ?', [joinerNode]))!
          .last_seen_at,
      ).toBeGreaterThanOrEqual(before);
    });

    it('the hub binds an unbound seat to the pusher on its first attached (ADR 328 §4 at ingest)', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      await addMember(joiner.store, await joinerTeam(), { name: 'ada', kind: 'agent' });
      await addMember(hub.store, await hubTeam(), { name: 'ada', kind: 'agent' });
      await attach(joiner.store, await memberId(joiner, 'ada'), 'codex', 'c1');
      await pushTeam(joinerCtx, await joinerTeam());
      const joinerNode = readNodeState().nodes['bravo']!.node_id;
      expect((await seatBinding(hub.store, await memberId(hub, 'ada')))?.node_id).toBe(joinerNode);
    });

    it('the hub refuses a presence event for a seat bound to another node; the cursor does not move (spec §2)', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      // nick is bound to the hub's own node, as a local claim on the hub would leave it (#1195).
      const hubNode = await localNodeForTeam(hub.store, (await hubTeam()).id);
      expect(
        await bindSeatToNode(
          hub.store,
          (await hubTeam()).id,
          await memberId(hub, 'nick'),
          hubNode.id,
        ),
      ).toEqual({
        bound: true,
      });
      // The joiner attaches nick anyway and pushes.
      await attach(joiner.store, await memberId(joiner, 'nick'), 'codex', 'c1');
      const cursorBefore = await cursor();
      const lines = await captureLogs(async () => await pushTeam(joinerCtx, await joinerTeam()));
      await expect(pushTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/bound_elsewhere|403/);
      expect(await cursor()).toBe(cursorBefore);
      expect(await stagedOnHub()).toEqual({ n: 0 });
      expect(
        lines.some((l) => l['msg'] === 'sync_push_refused_residence' && l['seat'] === 'nick'),
      ).toBe(true);
    });
  });
});

describe('wedgeKind (ADR 532)', () => {
  it('records every kind the hub names, and an unknown one as presence', () => {
    for (const k of [
      'message',
      'lane',
      'presence',
      'ledger',
      'policy',
      'continuity',
      'record',
      'seed',
    ])
      expect(wedgeKind(k)).toBe(k);
    expect(wedgeKind('something-new')).toBe('presence');
    expect(wedgeKind(undefined)).toBe('presence');
  });
});
