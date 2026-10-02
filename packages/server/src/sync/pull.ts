import {
  SYNC_PULL_MAX_BATCH,
  SyncPullResponseSchema,
  type SyncPullResponse,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { failureFields, log } from '../log.js';
import { readNodeState } from '../node/state.js';
import { handleFoldedMessages } from '../protocol/route.js';
import { listActiveTeams } from '../store/teams.js';
import { foldBatch, foldNodeLiveness, readPullCursor, type FoldStop } from './fold.js';
import { hasEnrolledJoiners, laneGenesis, readStaged } from './log.js';

/**
 * The pull half of the sync surface (ADR 325 increment 3b-ii): fetch the team's canonical order
 * past this daemon's cursor and fold it into `messages`. Two feeders, one fold — a joiner reads the
 * hub over HTTP; the hub reads its own `sync_log`. Shaped after `push.ts` (running flag, per-team
 * try/catch, unref'd timer, offline as the expected state).
 *
 * Every way the fold can stop has its own `error` line here, distinguishable from offline (`warn`)
 * — the push side learned that lesson at ADR 335 §7. A stall is reported once per distinct
 * blocker, not once per tick; the set clears when the fold moves again.
 *
 * A tick DRAINS rather than pages once (second-machine lane 01M3YZ0AY0, 2026-10-02): a page that
 * came back full is followed by the next one immediately, and the 60 s interval is only the wait
 * between pages when the hub had nothing more. A fresh joiner folds the whole log before it can
 * see a new act (docs/perf/cloud-seat.md finding 9), and at one page per tick revive's 156k-event
 * log put the first wake on a new laptop five hours out.
 */

export const SYNC_PULL_INTERVAL_MS = 60_000;
const PULL_TIMEOUT_MS = 10_000;

/**
 * Blockers already reported, so a stall logs once and not every tick. Cleared when the fold moves.
 * Keyed per daemon (`Ctx`), not per module: two in-process daemons on one slug — the two-daemon
 * acceptance, or any test that runs a hub and a joiner in one process — must not share a
 * suppression set, or the second daemon's first stall is silently "already reported" by the first
 * (dolly, #1155 review F3).
 */
const reportedByDb = new WeakMap<Ctx['db'], Set<string>>();
function reportedFor(ctx: Ctx): Set<string> {
  // Keyed on the database handle, not the Ctx object: the handle IS the daemon's identity, and a
  // Ctx may be re-assembled around it (tests build one per call).
  let set = reportedByDb.get(ctx.db);
  if (!set) {
    set = new Set<string>();
    reportedByDb.set(ctx.db, set);
  }
  return set;
}

async function localNodeId(ctx: Ctx, teamId: string): Promise<string | null> {
  return (
    (
      await ctx.db.get<{ node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?', [
        teamId,
      ])
    )?.node_id ?? null
  );
}

function reportStop(ctx: Ctx, team: string, stop: FoldStop): void {
  const reported = reportedFor(ctx);
  const key = `${team}:${JSON.stringify(stop)}`;
  if (reported.has(key)) return;
  reported.add(key);
  switch (stop.kind) {
    case 'unresolved_seat':
      log.error({
        msg: 'sync_fold_blocked',
        team,
        seat: stop.seat,
        hub_seq: stop.hub_seq,
        detail:
          'the fold names a seat this roster does not hold — not yet reconciled from git, or removed upstream; retrying each tick',
      });
      return;
    case 'unknown_act':
      log.error({
        msg: 'sync_fold_unknown_act',
        team,
        act: stop.act,
        hub_seq: stop.hub_seq,
        detail: 'a peer runs a newer build; upgrade this daemon — retrying each tick',
      });
      return;
    case 'id_collision':
      log.error({
        msg: 'sync_fold_id_collision',
        team,
        id: stop.id,
        held_origin: stop.held_origin,
        hub_seq: stop.hub_seq,
        detail: 'two origins minted one envelope id; terminal, needs operator attention',
      });
      return;
    case 'origin_gap':
      log.error({
        msg: 'sync_fold_origin_gap',
        team,
        origin: stop.origin,
        expected: stop.expected,
        got: stop.got,
        hub_seq: stop.hub_seq,
        detail:
          "the canonical order skipped an origin's sequence; the hub's invariant broke — terminal",
      });
      return;
    case 'unknown_lane_event':
    case 'unknown_presence_event':
      log.error({
        msg: 'sync_fold_unknown_event',
        team,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail: 'a peer runs a newer build; upgrade this daemon — retrying each tick',
      });
      return;
    case 'lane_unborn':
      log.error({
        msg: 'sync_fold_lane_unborn',
        team,
        lane: stop.lane,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail:
          'a transition for a lane this daemon never saw born (pre-2026-09-02 lane, or a hole); retrying each tick',
      });
      return;
    case 'presence_unborn':
      log.error({
        msg: 'sync_fold_presence_unborn',
        team,
        presence: stop.presence,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail: 'a re-attestation for a session this daemon never saw attach; retrying each tick',
      });
      return;
    case 'mistagged_ledger_event':
      log.error({
        msg: 'sync_fold_mistagged_ledger',
        team,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail:
          'a projected verb arrived under the non-projecting ledger tag; the origin runs a build that mis-tags — terminal, needs operator attention',
      });
      return;
    case 'unknown_policy_event':
    case 'unknown_continuity_event':
    case 'unknown_record_event':
      log.error({
        msg: 'sync_fold_unknown_event',
        team,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail: 'a peer runs a newer build; upgrade this daemon — retrying each tick',
      });
      return;
    case 'cursor_unborn':
      log.error({
        msg: 'sync_fold_cursor_unborn',
        team,
        message: stop.message,
        seat: stop.seat,
        hub_seq: stop.hub_seq,
        detail: 'a cursor names a message not yet folded here; transient — retrying each tick',
      });
      return;
    case 'seed_unborn':
      log.error({
        msg: 'sync_fold_seed_unborn',
        team,
        relay_id: stop.relay_id,
        hub_seq: stop.hub_seq,
        detail:
          'a seed-thread entry names a relay seed this daemon holds no row for; since ADR 399 the capture crosses as a `seed` event, so this closes on the tick that carries it — one relay poll OR one fold, whichever this node can do',
      });
      return;
    case 'unknown_seed_event':
      log.error({
        msg: 'sync_fold_unknown_seed_event',
        team,
        action: stop.action,
        hub_seq: stop.hub_seq,
        detail:
          'a seed verb this build cannot project (ADR 399); a seed projects into a table, so it stops rather than landing a row nothing reads — upgrade this daemon',
      });
      return;
  }
}

/**
 * A request that died because the connection it was written to had already been closed by the hub:
 * undici surfaces it as `TypeError: fetch failed` whose cause is `UND_ERR_SOCKET` ("other side
 * closed") or `ECONNRESET`. It is the keep-alive race — the hub's Node server closes an idle socket
 * after 5 s, and a joiner whose event loop was held by a long fold writes its next request to the
 * pooled socket before it has noticed. It says nothing about the hub being down (that is
 * `ECONNREFUSED`, a timeout, or a bad status), so only this shape is retried.
 */
export function isStaleSocket(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const code = (error.cause as { code?: unknown } | null | undefined)?.code;
  return code === 'UND_ERR_SOCKET' || code === 'ECONNRESET';
}

/**
 * Send a request again, at once, when it died on a stale pooled socket. The request never reached the
 * hub's handler and a pull is a GET, so a second attempt (on a fresh connection — undici drops the
 * dead one) cannot do harm. Without this the failure ended the whole drain tick and the next page
 * waited a full SYNC_PULL_INTERVAL_MS (second-machine run, 2026-10-02: 10 pages a minute instead of
 * one every second or two). Bounded: an outage that is really there still surfaces after `tries`.
 */
export async function withSocketRetry<T>(attempt: () => Promise<T>, tries = 3): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (n >= tries || !isStaleSocket(error)) throw error;
    }
  }
}

async function fetchPage(
  hubUrl: string,
  credential: string,
  slug: string,
  after: number,
): Promise<SyncPullResponse> {
  const url = new URL(`/teams/${slug}/sync/pull`, hubUrl);
  url.searchParams.set('after', String(after));
  url.searchParams.set('limit', String(SYNC_PULL_MAX_BATCH));
  const res = await withSocketRetry(() =>
    fetch(url, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    }),
  );
  if (res.status === 409) {
    // The hub's head is BELOW our cursor. A hub cannot un-hold what it acked; either this daemon's
    // cursor is wrong or the hub lost data. Neither is something a retry fixes, and believing the
    // hub downward here would re-apply events we hold — logged at error, not silently re-anchored.
    const body = (await res.json().catch(() => null)) as { hub_seq_high?: unknown } | null;
    log.error({
      msg: 'sync_pull_impossible_resume',
      team: slug,
      cursor: after,
      hub_seq_high: typeof body?.hub_seq_high === 'number' ? body.hub_seq_high : null,
      detail: 'the hub holds less than this daemon has applied; needs operator attention',
    });
    throw new Error(`hub head is below this daemon's pull cursor ${after} — impossible, refusing`);
  }
  if (!res.ok) throw new Error(`hub responded ${res.status}`);
  return SyncPullResponseSchema.parse(await res.json());
}

/** What one page of a pull came to. `full` says the hub may hold more: the page carried
 *  SYNC_PULL_MAX_BATCH events and the fold took every one. A short page is the head; a fold stop
 *  part-way is reported above and retried next tick, so it is never "full" — that is what keeps a
 *  blocked fold from spinning inside a drain. */
export interface PullPage {
  applied: number;
  full: boolean;
}

/** One team's pull pass. Returns how many events were applied. Exported for through-DB tests. */
export async function pullTeam(
  ctx: Ctx,
  team: { id: string; slug: string },
  now: number = Date.now(),
): Promise<number> {
  return (await pullPage(ctx, team, now)).applied;
}

/**
 * Drain one team within a tick: page after page while each comes back full. `stopped` is read
 * between pages, so a daemon shutting down finishes the page in flight and fetches no more.
 */
export async function drainTeam(
  ctx: Ctx,
  team: { id: string; slug: string },
  deps: {
    pull?: (ctx: Ctx, team: { id: string; slug: string }) => Promise<PullPage>;
    stopped?: () => boolean;
  } = {},
): Promise<{ pages: number; applied: number }> {
  const pull = deps.pull ?? pullPage;
  const stopped = deps.stopped ?? (() => false);
  let pages = 0;
  let applied = 0;
  for (;;) {
    const page = await pull(ctx, team);
    pages += 1;
    applied += page.applied;
    if (!page.full || stopped()) return { pages, applied };
  }
}

/** One page of one team's pull: fetch past the cursor, fold, report any stop. */
export async function pullPage(
  ctx: Ctx,
  team: { id: string; slug: string },
  now: number = Date.now(),
): Promise<PullPage> {
  const none: PullPage = { applied: 0, full: false };
  const nodeId = await localNodeId(ctx, team.id);
  // Same rule as push.ts: an enrollment is this daemon's only if it names this daemon's node row.
  const record = readNodeState().nodes[team.slug];
  const enrollment = record && record.node_id === nodeId ? record : undefined;
  // A hub that has never sent anything has no node row yet, and it hosts joiners all the same —
  // a hub is defined by who is enrolled WITH it, not by whether it has spoken. (push.ts needs the
  // row because it has nothing to push without one; the fold has plenty to apply.)
  const isHub = !enrollment && (await hasEnrolledJoiners(ctx.db, team.id, nodeId ?? ''));
  if (!enrollment && !isHub) return none;

  const cursor = await readPullCursor(ctx.db, team.id);
  // The hub sends its watermark; folding our own staged log (the loopback arm) reads it from the
  // same table the events came from — either way it describes the log being folded, not this daemon.
  const page: Pick<SyncPullResponse, 'events' | 'nodes' | 'lane_genesis'> = enrollment
    ? await fetchPage(enrollment.hub_url, enrollment.credential, team.slug, cursor)
    : {
        events: await readStaged(ctx.db, team.id, cursor, SYNC_PULL_MAX_BATCH),
        nodes: [],
        lane_genesis: await laneGenesis(ctx.db, team.id),
      };
  // Node liveness lands even when the page is empty: a quiet team still needs to know its
  // machines are alive (presence replication §3). The hub reads its own table and folds none.
  if (page.nodes.length > 0) await foldNodeLiveness(ctx.db, team.id, page.nodes);
  if (page.events.length === 0) return none;

  const result = await foldBatch(ctx.db, team.id, page.events, now, page.lane_genesis);
  if (result.stop) {
    reportStop(ctx, team.slug, result.stop);
  } else {
    const reported = reportedFor(ctx);
    for (const key of reported) if (key.startsWith(`${team.slug}:`)) reported.delete(key);
  }
  // The incident pool is the hub's async (ADR 371 §2): a joiner's `blocked_by` report crosses on the
  // status_update it rides, and the hub records it HERE, when that message folds — the route-time
  // hook a message posted directly to the hub gets, fired for a folded one. Only the hub: a joiner
  // folding the same message must not count it, or there would be one pool per machine again.
  if (isHub && result.messages.length > 0) {
    try {
      await handleFoldedMessages(ctx, team.slug, result.messages);
    } catch (err) {
      log.warn({ msg: 'incident_hook_failed', team: team.slug, err: String(err) });
    }
  }
  return {
    applied: result.applied,
    full: page.events.length === SYNC_PULL_MAX_BATCH && result.stop === null,
  };
}

/** Start the pull loop. Returns a stop function (same contract as startSyncPush). */
export function startSyncPull(ctx: Ctx): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const team of await listActiveTeams(ctx.db)) {
        if (stopped) break;
        try {
          const { pages, applied } = await drainTeam(ctx, team, { stopped: () => stopped });
          if (pages > 1) log.info({ msg: 'sync_drained', team: team.slug, pages, applied });
          else if (applied > 0) log.info({ msg: 'sync_pulled', team: team.slug, applied });
        } catch (error) {
          // Offline is the expected failure for a laptop; the classified stops above already wrote
          // their own error line before this warn.
          log.warn({ msg: 'sync_pull_failed', team: team.slug, ...failureFields(error) });
        }
      }
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), SYNC_PULL_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
