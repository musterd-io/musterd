import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { type Database } from '../db/open.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { addMember } from '../store/members.js';
import { insertMessage, localNodeForTeam } from '../store/messages.js';
import { bindSeatToNode } from '../store/nodes.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { foldBatch } from './fold.js';
import {
  drainTeam,
  isStaleSocket,
  pullTeam,
  readPullStop,
  SYNC_STOP_WARN_AFTER_MS,
  withSocketRetry,
} from './pull.js';
import { pushTeam } from './push.js';

withDrivers('pull', (_o, kind) => {
  /**
   * The pull side (ADR 325 increment 3b-ii), exercised between two real daemons: the route that pages
   * the hub's canonical order, and the loop that feeds it to the fold on hub and joiner alike.
   *
   * Harness copied from push.test.ts so this file stands alone — a test that imports another test's
   * lifecycle is a test whose setup nobody can read in one place.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickCredential: string;
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

  /**
   * Run `fn` and collect the daemon's log lines, so a test can assert what an OPERATOR would see
   * rather than only what the caller catches (ADR 335 §7 decision 7). MUSTERD_SILENT is lifted for
   * the call because the visibility of the line IS the property under test.
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
    await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } });
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(base: string, path: string, auth?: string) {
    const response = await fetch(base + path, {
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
  }
  const joinerCredential = () => readNodeState().nodes['bravo']!.credential;

  describe('GET /sync/pull', () => {
    it('refuses without a machine credential', async () => {
      expect((await get(hubBase, '/teams/bravo/sync/pull?after=0')).status).toBe(401);
      expect((await get(hubBase, '/teams/bravo/sync/pull?after=0', nickCredential)).status).toBe(
        401,
      );
    });

    it('pages the canonical order after a hub_seq, bounded, with the head', async () => {
      await send(joiner, 'j-1');
      await enrollJoiner();
      await send(joiner, 'j-2');
      await send(joiner, 'j-3');
      await pushTeam(joinerCtx, await joinerTeam());
      const page = await get(hubBase, '/teams/bravo/sync/pull?after=1&limit=1', joinerCredential());
      expect(page.status).toBe(200);
      expect(page.json.hub_seq_high).toBe(3);
      expect(page.json.events).toHaveLength(1);
      expect(page.json.events[0]).toMatchObject({ hub_seq: 2, origin_seq: 2 });
      expect(page.json.events[0].envelope.id).toBe('j-2');
    });

    it('answers 409 with the head when asked to resume past it', async () => {
      await send(joiner, 'j-1');
      await enrollJoiner();
      await pushTeam(joinerCtx, await joinerTeam());
      const res = await get(hubBase, '/teams/bravo/sync/pull?after=5', joinerCredential());
      expect(res.status).toBe(409);
      expect(res.json.hub_seq_high).toBe(1);
    });
  });

  describe('seat bindings ride the pull page (ADR 509)', () => {
    it('the hub lists every binding by member name, and a joiner replaces its table from the page', async () => {
      await send(joiner, 'j-1'); // mints the joiner's node row, which enrollment names
      await enrollJoiner();
      const hubTeamRow = (await getTeamBySlug(hub.store, 'bravo'))!;
      const hubNode = (await localNodeForTeam(hub.store, hubTeamRow.id)).id;
      const nick = (await hub.store.get<{ id: string }>(
        'SELECT id FROM members WHERE team_id = ? AND name = ?',
        [hubTeamRow.id, 'nick'],
      ))!;
      expect((await bindSeatToNode(hub.store, hubTeamRow.id, nick.id, hubNode, 5_000)).bound).toBe(
        true,
      );

      await send(hub, 'h-1');
      const page = await get(hubBase, '/teams/bravo/sync/pull?after=0', joinerCredential());
      expect(page.status).toBe(200);
      expect(page.json.seat_nodes).toEqual([{ member: 'nick', node_id: hubNode, bound_at: 5_000 }]);

      // An empty page still lands the bindings, like node liveness: a quiet team's picker must
      // still know where its seats live.
      await pullTeam(joinerCtx, await joinerTeam());
      const mine = await joiner.store.all<{ member: string; node_id: string }>(
        `SELECT m.name AS member, s.node_id FROM seat_nodes s JOIN members m ON m.id = s.member_id
          WHERE s.team_id = ?`,
        [(await joinerTeam()).id],
      );
      expect(mine).toEqual([{ member: 'nick', node_id: hubNode }]);
    });
  });

  // The hub daemon's OWN config: the pull-stop registry is keyed on it (one object per daemon), so a
  // test that re-minted a config per call would be reading a different daemon's state each time.
  const hubCtx = () => ({
    db: hub.store,
    hub: new Hub(),
    config: hub.config,
    rosterRoots: [],
  });
  const hubTeam = async () => (await getTeamBySlug(hub.store, 'bravo'))!;
  const originsIn = async (db: Database, teamId: string) =>
    await db.all(
      'SELECT id, origin_seq FROM messages WHERE team_id = ? ORDER BY origin_node, origin_seq',
      [teamId],
    );
  /** A seat that exists on one daemon only — roster lag, the ordinary case the fold blocks on. */
  const addSeat = async (server: RunningServer, name: string) =>
    (
      await addMember(server.store, await (await getTeamBySlug(server.store, 'bravo'))!, {
        name,
        kind: 'agent',
      })
    ).row;

  describe('the pull loop', () => {
    it('the hub folds joiner events into its own messages from its own sync_log', async () => {
      await send(joiner, 'j-1');
      await enrollJoiner();
      await send(joiner, 'j-2');
      await pushTeam(joinerCtx, await joinerTeam());
      expect(await pullTeam(hubCtx(), await hubTeam())).toBe(2);
      expect(
        await hub.store.get('SELECT COUNT(*) AS n FROM messages WHERE id IN (?, ?)', [
          'j-1',
          'j-2',
        ]),
      ).toEqual({ n: 2 });
      // Second pass: nothing new.
      expect(await pullTeam(hubCtx(), await hubTeam())).toBe(0);
    });

    it("a joiner receives the hub's own history AND its own events back, stamps verbatim, ids local", async () => {
      await send(hub, 'h-1');
      await send(joiner, 'j-1');
      await enrollJoiner();
      // Hub stages its own history (loopback) and ingests the joiner's push.
      await pushTeam(joinerCtx, await joinerTeam());
      await pushTeam(hubCtx(), await hubTeam());
      // Joiner pulls: gets h-1 (foreign to it) and j-1 (its own — skipped, rule 1).
      expect(await pullTeam(joinerCtx, await joinerTeam())).toBe(1);
      const h1 = await joiner.store.get(
        'SELECT from_member, origin_node, origin_seq FROM messages WHERE id = ?',
        ['h-1'],
      )!;
      const hubLocal = (await hub.store.get('SELECT node_id FROM local_node WHERE team_id = ?', [
        (await hubTeam()).id,
      ]))!.node_id;
      expect(h1.origin_node).toBe(hubLocal);
      expect(h1.origin_seq).toBe(1);
      const joinerNick = (await joiner.store.get(
        'SELECT id FROM members WHERE team_id = ? AND name = ?',
        [(await joinerTeam()).id, 'nick'],
      ))!.id;
      expect(h1.from_member).toBe(joinerNick);
      // And the joiner's own row is still the one insertMessage wrote — not a second copy.
      expect(
        (await originsIn(joiner.store, (await joinerTeam()).id)).filter((r) => r.id === 'j-1'),
      ).toHaveLength(1);
    });

    it('logs the blocker at error, once per seat, and resumes after the roster catches up', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      const late = await addSeat(joiner, 'late');
      await insertMessage(
        joiner.store,
        (await joinerTeam()).id,
        late.id,
        null,
        makeEnvelope({
          id: 'l-1',
          team: 'bravo',
          from: 'late',
          to: { kind: 'team' },
          act: 'message',
          body: 'hi',
          ts: 1,
        }),
      );
      await pushTeam(joinerCtx, await joinerTeam());

      const lines = await captureLogs(async () => await pullTeam(hubCtx(), await hubTeam()));
      const blocked = lines.filter((l) => l['msg'] === 'sync_fold_blocked');
      expect(blocked).toHaveLength(1);
      expect(blocked[0]).toMatchObject({ level: 'error', seat: 'late' });
      // j-0 (before the blocker) applied; l-1 did not.
      expect(
        await hub.store.get('SELECT COUNT(*) AS n FROM messages WHERE id = ?', ['l-1']),
      ).toEqual({
        n: 0,
      });
      // Same blocker again: no second error line.
      const again = await captureLogs(async () => await pullTeam(hubCtx(), await hubTeam()));
      expect(again.filter((l) => l['msg'] === 'sync_fold_blocked')).toHaveLength(0);

      await addSeat(hub, 'late');
      expect(await pullTeam(hubCtx(), await hubTeam())).toBe(1);
    });

    it('a stop that holds the cursor is readable as a standing warning after a grace, and clears when the fold moves (ADR 547)', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      const late = await addSeat(joiner, 'late');
      await insertMessage(
        joiner.store,
        (await joinerTeam()).id,
        late.id,
        null,
        makeEnvelope({
          id: 'l-1',
          team: 'bravo',
          from: 'late',
          to: { kind: 'team' },
          act: 'message',
          body: 'hi',
          ts: 1,
        }),
      );
      await pushTeam(joinerCtx, await joinerTeam());
      const t0 = 1_000_000_000_000;
      const team = await hubTeam();

      // Nothing has stopped yet.
      expect(await readPullStop(hub.config, team.id, t0)).toBeNull();

      await pullTeam(hubCtx(), team, t0);
      // A stop of one tick is routine (the roster is usually a pull away): quiet inside the grace.
      expect(await readPullStop(hub.config, team.id, t0 + 60_000)).toBeNull();

      // Still stopped on the next tick, which must not restart the clock.
      await pullTeam(hubCtx(), team, t0 + 60_000);
      const stop = await readPullStop(hub.config, team.id, t0 + SYNC_STOP_WARN_AFTER_MS);
      expect(stop).toMatchObject({ kind: 'unresolved_seat', subject: 'late', since: t0 });
      expect(stop!.hub_seq).toBeGreaterThan(0);

      // The roster every seat session reads carries it (the route reads the real clock, long past
      // this test's t0 + grace).
      const held = await get(hubBase, '/teams/bravo/members', nickCredential);
      expect(held.json.sync.pull_stopped).toMatchObject({
        kind: 'unresolved_seat',
        subject: 'late',
        since: t0,
      });

      // The roster catches up; the next pull folds past it and the warning goes.
      await addSeat(hub, 'late');
      await pullTeam(hubCtx(), team, t0 + 2 * SYNC_STOP_WARN_AFTER_MS);
      expect(await readPullStop(hub.config, team.id, t0 + 2 * SYNC_STOP_WARN_AFTER_MS)).toBeNull();
      const cleared = await get(hubBase, '/teams/bravo/members', nickCredential);
      expect(cleared.json.sync.pull_stopped).toBeNull();
    });

    /**
     * dolly's #1155 F1. The fold classifies an act this build cannot name (`unknown_act`: "upgrade
     * this daemon", valid prefix applied, retried each tick). But over the WIRE that stop was
     * unreachable: the hub re-parsed its own page with an `Act`-enum schema, so one poisoned row made
     * `GET /sync/pull` answer 500 with a raw ZodError to every puller, which logged `sync_pull_failed`
     * (indistinguishable from offline) and applied nothing — not even the rows before it. The
     * loopback feeder skipped the parse and reached the stop, so the two feeders diverged on the
     * same log. The wire now carries what the log holds; both feeders converge on the fold's stop.
     */
    it('an act this build cannot name reaches the fold over the wire — prefix applied, stop classified, no 500', async () => {
      await send(hub, 'h-1');
      await send(hub, 'h-2');
      await send(hub, 'h-3');
      await send(joiner, 'j-1'); // the joiner needs a node row before it can enroll
      await enrollJoiner();
      await pushTeam(hubCtx(), await hubTeam()); // hub stages its own history
      // A hub on a newer build staged h-2 with an act this puller's ActSchema does not hold.
      await hub.store.run(
        hub.store.dialect === 'sqlite'
          ? "UPDATE sync_log SET payload = json_set(payload, '$.envelope.act', 'frobnicate') WHERE team_id = ? AND json_extract(payload, '$.envelope.id') = 'h-2'"
          : "UPDATE sync_log SET payload = jsonb_set(payload::jsonb, '{envelope,act}', '\"frobnicate\"')::text WHERE team_id = ? AND json_extract(payload, '$.envelope.id') = 'h-2'",
        [(await hubTeam()).id],
      );

      const lines = await captureLogs(async () => await pullTeam(joinerCtx, await joinerTeam()));
      const unknown = lines.filter((l) => l['msg'] === 'sync_fold_unknown_act');
      expect(unknown).toHaveLength(1);
      expect(unknown[0]).toMatchObject({ level: 'error', act: 'frobnicate' });
      // The prefix before the blocker landed; the blocker and what follows did not.
      const held = async (id: string) =>
        (
          (await joiner.store.get('SELECT COUNT(*) AS n FROM messages WHERE id = ?', [id])) as {
            n: number;
          }
        ).n;
      expect(await held('h-1')).toBe(1);
      expect(await held('h-2')).toBe(0);
      expect(await held('h-3')).toBe(0);
      // Same stop next tick: no second line, and still not a transport failure.
      const again = await captureLogs(async () => await pullTeam(joinerCtx, await joinerTeam()));
      expect(again.filter((l) => l['msg'] === 'sync_fold_unknown_act')).toHaveLength(0);
      // Once "upgraded" — the staged act is one this build knows — the fold resumes past it.
      await hub.store.run(
        hub.store.dialect === 'sqlite'
          ? "UPDATE sync_log SET payload = json_set(payload, '$.envelope.act', 'message') WHERE team_id = ? AND json_extract(payload, '$.envelope.id') = 'h-2'"
          : "UPDATE sync_log SET payload = jsonb_set(payload::jsonb, '{envelope,act}', '\"message\"')::text WHERE team_id = ? AND json_extract(payload, '$.envelope.id') = 'h-2'",
        [(await hubTeam()).id],
      );
      // The doorbell the enrollment opened may fold the pair before this pull does; what is owed is
      // that the fold resumed past the blocker, not which caller got there first.
      await pullTeam(joinerCtx, await joinerTeam());
      for (let i = 0; i < 200 && (await held('h-3')) === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await held('h-2')).toBe(1);
      expect(await held('h-3')).toBe(1);
    });

    it('a puller refuses a hub head below its own cursor as impossible', async () => {
      await send(joiner, 'j-0');
      await enrollJoiner();
      // Pretend the joiner has applied further than the hub has ever held.
      await joiner.store.run(
        'INSERT INTO sync_pull_cursor (team_id, last_hub_seq, updated_at) VALUES (?, 99, 1)',
        [(await joinerTeam()).id],
      );
      const lines = await captureLogs(async () => await pullTeam(joinerCtx, await joinerTeam()));
      expect(lines.some((l) => l['msg'] === 'sync_pull_impossible_resume')).toBe(true);
      await expect(pullTeam(joinerCtx, await joinerTeam())).rejects.toThrow(/impossible/);
    });

    it('does nothing on a single-machine install', async () => {
      await send(hub, 'h-1');
      expect(await pullTeam(hubCtx(), await hubTeam())).toBe(0);
      expect(await foldBatch(hub.store, (await hubTeam()).id, [])).toMatchObject({
        applied: 0,
        skipped: 0,
        last_hub_seq: 0,
        stop: null,
      });
    });
  });
});

/**
 * The drain (second-machine lane 01M3YZ0AY0): a fresh joiner folds the whole log before it can see
 * a new act, and at one page per tick revive's 156k events were five hours away. These run the loop's
 * paging decision against a stub pull — no daemons, no DB — because the decision is the whole change.
 */
describe('drainTeam — a full page is followed by the next one now, not next tick', () => {
  const team = { id: 't', slug: 'bravo' };
  const ctx = {} as Ctx;
  /** A pull stub that serves pages in order and records each call; past the end it is quiet. */
  function pages(seq: Array<{ applied: number; full: boolean }>) {
    const calls: number[] = [];
    return {
      calls,
      pull: async () => {
        const next = seq[calls.length] ?? { applied: 0, full: false };
        calls.push(next.applied);
        return next;
      },
    };
  }

  it('keeps pulling while pages come back full, and stops on the first short one', async () => {
    const p = pages([
      { applied: 500, full: true },
      { applied: 500, full: true },
      { applied: 120, full: false },
    ]);
    expect(await drainTeam(ctx, team, { pull: p.pull })).toEqual({ pages: 3, applied: 1120 });
    expect(p.calls).toHaveLength(3);
  });

  it('a short first page is one pull — the quiet-team tick is unchanged', async () => {
    const p = pages([{ applied: 3, full: false }]);
    expect(await drainTeam(ctx, team, { pull: p.pull })).toEqual({ pages: 1, applied: 3 });
    expect(p.calls).toHaveLength(1);
  });

  it('a full page that was also the last costs one extra, empty pull', async () => {
    const p = pages([{ applied: 500, full: true }]);
    expect(await drainTeam(ctx, team, { pull: p.pull })).toEqual({ pages: 2, applied: 500 });
  });

  it('a fold stop part-way is not a full page: the next tick retries it, nothing spins', async () => {
    // pullPage reports a page with a stop as not full even when the hub sent a full one.
    const p = pages([
      { applied: 500, full: true },
      { applied: 17, full: false },
      { applied: 500, full: true },
    ]);
    expect(await drainTeam(ctx, team, { pull: p.pull })).toEqual({ pages: 2, applied: 517 });
  });

  it('stop ends the drain after the page in flight', async () => {
    let stopped = false;
    const p = pages([
      { applied: 500, full: true },
      { applied: 500, full: true },
    ]);
    const pull = async () => {
      const r = await p.pull();
      stopped = true;
      return r;
    };
    expect(await drainTeam(ctx, team, { pull, stopped: () => stopped })).toEqual({
      pages: 1,
      applied: 500,
    });
  });
});

/**
 * Second-machine run, 2026-10-02: a joiner draining a long log folded a page in more than the hub's
 * 5 s keep-alive window, the hub closed the idle socket, and the NEXT request — written to that pooled
 * dead socket before the joiner's event loop had seen the close — died `fetch failed`
 * (`UND_ERR_SOCKET: other side closed`). The tick ended, so the drain waited a minute per failure.
 * The request never reached the hub's handler and a GET is idempotent: dial fresh and send it again.
 */
describe('withSocketRetry — a request that died on a socket the hub had already closed', () => {
  const staleSocket = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });

  it('names a stale pooled socket, and nothing else', () => {
    expect(isStaleSocket(staleSocket())).toBe(true);
    expect(
      isStaleSocket(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe(true);
    // A refused connection, a timeout and a plain error are the hub being down or slow, not a race.
    expect(
      isStaleSocket(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe(false);
    expect(isStaleSocket(new DOMException('timed out', 'TimeoutError'))).toBe(false);
    expect(isStaleSocket(new Error('boom'))).toBe(false);
    expect(isStaleSocket(undefined)).toBe(false);
  });

  it('retries a stale socket and returns the next attempt, without waiting a tick', async () => {
    let calls = 0;
    const result = await withSocketRetry(async () => {
      calls += 1;
      if (calls === 1) throw staleSocket();
      return 'page';
    });
    expect(result).toBe('page');
    expect(calls).toBe(2);
  });

  it('gives up after the attempt budget and surfaces the last error', async () => {
    let calls = 0;
    await expect(
      withSocketRetry(async () => {
        calls += 1;
        throw staleSocket();
      }, 3),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  it('does not retry anything else — a hub that is down or a bad status fails at once', async () => {
    let calls = 0;
    await expect(
      withSocketRetry(async () => {
        calls += 1;
        throw new Error('hub responded 500');
      }),
    ).rejects.toThrow('hub responded 500');
    expect(calls).toBe(1);
  });
});
