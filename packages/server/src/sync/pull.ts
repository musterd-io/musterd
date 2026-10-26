import {
  SYNC_PULL_MAX_BATCH,
  SyncLanesResponseSchema,
  sanitizeStopSubject,
  SyncPullResponseSchema,
  type SyncPullResponse,
  type SyncPullStop,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { failureFields, log } from '../log.js';
import { readNodeState } from '../node/state.js';
import { deliverFoldedLive, handleFoldedMessages } from '../protocol/route.js';
import { countLanesBefore, insertLaneSnapshot } from '../store/lanes.js';
import { getMemberById, haltedSentence } from '../store/members.js';
import { replaceSeatBindings } from '../store/nodes.js';
import { listActiveTeams } from '../store/teams.js';
import { foldBatch, foldNodeLiveness, readPullCursor, type FoldStop } from './fold.js';
import { noteHubLinkFailure, noteHubLinkOk } from './hubLink.js';
import { noteHubStop } from './hubStop.js';
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
const reportedByConfig = new WeakMap<Ctx['config'], Set<string>>();
function reportedFor(ctx: Ctx): Set<string> {
  // Keyed on the resolved config, not the Ctx object and not the db handle: a Ctx is re-assembled
  // per request (`teamCtx` spreads it) and on Postgres `forTeam()` mints a NEW handle each call, so
  // a handle-keyed registry written by the loop is invisible to the request that reads it
  // (PGlite CI, 2026-10-08: every kick missed, reads of the pull stop came back null).
  let set = reportedByConfig.get(ctx.config);
  if (!set) {
    set = new Set<string>();
    reportedByConfig.set(ctx.config, set);
  }
  return set;
}

/**
 * ADR 547: how long a stop must hold the cursor before the roster calls it a warning. One tick is
 * routine — the seat file is usually a `git pull` away — so a stop is quiet for the first five
 * minutes and loud after. It was three days quiet on 2026-10-08 (alfie, hub_seq 191206).
 */
export const SYNC_STOP_WARN_AFTER_MS = 5 * 60_000;

/**
 * The stop currently holding each team's pull cursor, per daemon. In memory on purpose: the fold
 * recomputes the same stop every tick (it is retried, never skipped), so a restart re-derives it
 * within one `SYNC_PULL_INTERVAL_MS` and nothing here needs a migration. `since` is the first tick
 * that saw THIS stop; the same stop on the next tick keeps it, a different one restarts it.
 */
const pullStopsByConfig = new WeakMap<Ctx['config'], Map<string, SyncPullStop>>();

/** The thing a stop names — a seat, an act, a lane — for the sentence the roster prints. */
function stopSubject(stop: FoldStop): string | null {
  if ('seat' in stop) return stop.seat;
  if ('lane' in stop) return stop.lane;
  if ('act' in stop) return stop.act;
  if ('presence' in stop) return stop.presence;
  if ('action' in stop) return stop.action;
  if ('id' in stop) return stop.id;
  if ('origin' in stop) return stop.origin;
  return null;
}

function notePullStop(ctx: Ctx, teamId: string, stop: FoldStop, now: number): void {
  let teams = pullStopsByConfig.get(ctx.config);
  if (!teams) pullStopsByConfig.set(ctx.config, (teams = new Map()));
  const subject = sanitizeStopSubject(stopSubject(stop));
  const prior = teams.get(teamId);
  const same = prior?.kind === stop.kind && prior.subject === subject;
  teams.set(teamId, {
    kind: stop.kind,
    subject,
    hub_seq: stop.hub_seq,
    since: same ? prior.since : now,
  });
}

function clearPullStop(ctx: Ctx, teamId: string): void {
  pullStopsByConfig.get(ctx.config)?.delete(teamId);
}

/**
 * This daemon's standing pull stop for the team, or null — read by the roster. Null inside the
 * grace, and null on a machine whose fold is moving (or that has no hub).
 */
export async function readPullStop(
  config: Ctx['config'],
  teamId: string,
  now: number = Date.now(),
): Promise<SyncPullStop | null> {
  const stop = pullStopsByConfig.get(config)?.get(teamId);
  return stop && now - stop.since >= SYNC_STOP_WARN_AFTER_MS ? stop : null;
}

/**
 * ADR 591: the same stop with no grace — what the hub puts on every push and pull answer so a
 * joiner learns at once that its events are accepted but held. The joiner applies the grace from
 * the stop's own `since` before it warns (`sync/hubStop.ts`).
 */
export function peekPullStop(config: Ctx['config'], teamId: string): SyncPullStop | null {
  return pullStopsByConfig.get(config)?.get(teamId) ?? null;
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
    // The fold is synchronous, so without this the next page's fetch went out in the same
    // macrotask as the last COMMIT: undici reused a pooled socket the hub had already closed before
    // it could read the FIN (why #1989's retry exists — it stays as the belt). One turn of the loop
    // lets the FIN land, and lets the requests queued behind a long drain run between pages.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** One page of one team's pull: fetch past the cursor, fold, report any stop. */
/**
 * ADR 544: the hub's lanes older than its replicated history, fetched whole. Only a joiner calls
 * this, and only when a pull page said the hub holds more pre-genesis lanes than this daemon does.
 */
async function fetchPreGenesisLanes(hubUrl: string, credential: string, slug: string) {
  const res = await withSocketRetry(() =>
    fetch(new URL(`/teams/${slug}/sync/lanes`, hubUrl), {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    }),
  );
  if (!res.ok) throw new Error(`hub responded ${res.status} to /sync/lanes`);
  return SyncLanesResponseSchema.parse(await res.json());
}

/**
 * ADR 544: adopt the hub's pre-genesis lanes this daemon lacks. A lane born before the hub's log
 * began has no `lane.opened` anywhere, so its transitions fold `lane_unborn` forever and every
 * acceptance ask or handoff naming it stays owed (101 acts on one joiner, 2026-10-07). The page's
 * `pre_genesis_lanes` count against this daemon's own says whether there is anything to fetch;
 * rows are inserted only where absent, never updated — a row already here converges through the
 * fold. Self-healing and stateless: the next page re-compares. Returns how many rows were adopted.
 */
export async function adoptPreGenesisLanes(
  ctx: Ctx,
  team: { id: string; slug: string },
  enrollment: { hub_url: string; credential: string },
  page: Pick<SyncPullResponse, 'lane_genesis' | 'pre_genesis_lanes'>,
): Promise<number> {
  if (page.lane_genesis === null || page.pre_genesis_lanes === 0) return 0;
  const held = await countLanesBefore(ctx.db, team.id, page.lane_genesis);
  if (held >= page.pre_genesis_lanes) return 0;
  const snapshot = await fetchPreGenesisLanes(enrollment.hub_url, enrollment.credential, team.slug);
  let adopted = 0;
  for (const lane of snapshot.lanes) {
    if (await insertLaneSnapshot(ctx.db, team.id, lane)) adopted++;
  }
  if (adopted > 0) log.info({ msg: 'sync_pre_genesis_lanes_adopted', team: team.slug, adopted });
  return adopted;
}

/** ADR 738: a joiner's page fetch, recorded on the hub link either way it goes. */
async function fetchPageNoting(
  ctx: Ctx,
  teamId: string,
  enrollment: { hub_url: string; credential: string },
  slug: string,
  cursor: number,
): Promise<SyncPullResponse> {
  try {
    const page = await fetchPage(enrollment.hub_url, enrollment.credential, slug, cursor);
    noteHubLinkOk(ctx, teamId, enrollment.hub_url);
    return page;
  } catch (err) {
    await noteHubLinkFailure(ctx, teamId, enrollment.hub_url, err);
    throw err;
  }
}

export async function pullPage(
  ctx: Ctx,
  team: { id: string; slug: string },
  now: number = Date.now(),
  afterRefresh = false,
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
  const page: Pick<
    SyncPullResponse,
    'events' | 'nodes' | 'seat_nodes' | 'lane_genesis' | 'pre_genesis_lanes' | 'fold_stopped'
  > = enrollment
    ? await fetchPageNoting(ctx, team.id, enrollment, team.slug, cursor)
    : {
        events: await readStaged(ctx.db, team.id, cursor, SYNC_PULL_MAX_BATCH),
        nodes: [],
        seat_nodes: [],
        lane_genesis: await laneGenesis(ctx.db, team.id),
        pre_genesis_lanes: 0,
        fold_stopped: null,
      };
  // ADR 591: what the hub says about its own fold, on every page — a quiet joiner still pulls, so
  // a hub held on a seat this machine minted is loud here within one tick, not only on the hub.
  if (enrollment) noteHubStop(ctx, team.id, page.fold_stopped);
  // ADR 544: a joiner adopts the lanes the log can never carry. Best-effort — a failed snapshot
  // must not stop the page from folding; the next page re-compares and asks again.
  if (enrollment) {
    try {
      await adoptPreGenesisLanes(ctx, team, enrollment, page);
    } catch (err) {
      log.warn({ msg: 'sync_pre_genesis_lanes_failed', team: team.slug, err: String(err) });
    }
  }
  // Node liveness lands even when the page is empty: a quiet team still needs to know its
  // machines are alive (presence replication §3). The hub reads its own table and folds none.
  if (page.nodes.length > 0) await foldNodeLiveness(ctx.db, team.id, page.nodes);
  // ADR 509: so does where every seat lives — a joiner's roster then names the hub's seats'
  // machine instead of reading them as `nowhere`. Only a joiner takes the page's bindings; the
  // hub's own table is the source. An older hub sends none and this daemon keeps what it holds.
  if (enrollment && page.seat_nodes.length > 0)
    await replaceSeatBindings(ctx.db, team.id, page.seat_nodes);
  if (page.events.length === 0) {
    // Nothing past the cursor: whatever stopped it before has been folded or is gone.
    clearPullStop(ctx, team.id);
    return none;
  }

  const result = await foldBatch(ctx.db, team.id, page.events, now, page.lane_genesis);
  // ADR 500: held, not stopped — one line per page, so a seed that never arrives stays findable.
  // `projectHeldThreads` projects these on the seed's birth; until then they live in `audit` only.
  if (result.held_seed_threads.length > 0) {
    const [first] = result.held_seed_threads;
    log.warn({
      msg: 'sync_fold_seed_thread_held',
      team: team.slug,
      count: result.held_seed_threads.length,
      relay_id: first!.relay_id,
      hub_seq: first!.hub_seq,
      detail:
        'seed-thread entries for a seed this daemon holds no row for — held in audit, projected when the seed is captured here (ADR 500); a seed captured before ADR 399 never is',
    });
  }
  if (result.stop) {
    // ADR 592: an unknown seat is usually a seat file one `git pull` away. Pull it ourselves, once
    // per page, and fold again in the same tick when something arrived — the stop below is the
    // outcome only when the roster still lacks the seat after that. Everything before the stop has
    // already committed, so the second pass is the next page from the advanced cursor.
    if (result.stop.kind === 'unresolved_seat' && ctx.onUnresolvedSeat && !afterRefresh) {
      let moved = false;
      try {
        moved = await ctx.onUnresolvedSeat(team, result.stop.seat);
      } catch (err) {
        log.warn({ msg: 'sync_roster_refresh_failed', team: team.slug, err: String(err) });
      }
      if (moved) return pullPage(ctx, team, now, true);
    }
    reportStop(ctx, team.slug, result.stop);
    notePullStop(ctx, team.id, result.stop, now);
  } else {
    clearPullStop(ctx, team.id);
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
  // Live push to whoever is connected HERE (hub and joiner alike): the fold only wrote `messages`.
  if (result.messages.length > 0) await deliverFoldedLive(ctx, team.slug, result.messages);
  // ADR 525: a halt decided on the hub reached this node. The fold set the standing and revoked the
  // leases; a live socket here is closed now with the halt's own sentence, as the deciding node does.
  for (const memberId of result.halted ?? []) await evictHalted(ctx, team.id, memberId);
  return {
    applied: result.applied,
    full: page.events.length === SYNC_PULL_MAX_BATCH && result.stop === null,
  };
}

/** Close every live socket a halted seat holds on this node, and tell the room it went offline. */
async function evictHalted(ctx: Ctx, teamId: string, memberId: string): Promise<void> {
  const conns = ctx.hub.connsForMember(memberId);
  if (conns.length === 0) return;
  const seat = await getMemberById(ctx.db, memberId);
  const sentence = seat ? haltedSentence(seat) : 'halted by a human (ADR 501)';
  for (const c of conns) {
    c.send({ type: 'error', code: 'superseded', message: sentence });
    c.close?.();
    ctx.hub.remove(c.connId);
  }
  const name = conns[0]?.memberName;
  if (conns.length > 0 && name)
    ctx.hub.broadcastTeam(teamId, { type: 'presence', member: name, status: 'offline' });
}

/** How long a kick waits so a burst of arrivals is one drain. */
export const SYNC_PULL_KICK_DEBOUNCE_MS = 100;

/** The running loop's doorbell, by database handle (same keying as push.ts's). Absent when no
 *  pull loop runs, so a kick is then a no-op. */
const kickers = new WeakMap<Ctx['config'], () => void>();

/**
 * Ask this daemon's pull loop to drain now. The hub rings it when `/sync/push` stages events:
 * without it a pushed act sits in `sync_log` until the hub's own next tick before any seat on the
 * hub can read it — a second 60 s on top of the push interval (measured 2026-10-08: joiner send →
 * hub `messages` 60 051 ms with push-on-write already in). Never throws, never blocks the caller.
 */
export function kickSyncPull(ctx: Ctx): void {
  kickers.get(ctx.config)?.();
}

/** Start the pull loop. Returns a stop function (same contract as startSyncPush). */
export function startSyncPull(ctx: Ctx): () => void {
  let running = false;
  let again = false; // a kick landed mid-drain: its events may be past the page already read
  let stopped = false;
  const tick = async () => {
    if (running) {
      again = true;
      return;
    }
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
    if (again && !stopped) {
      again = false;
      void tick();
    }
  };
  const handle = setInterval(() => void tick(), SYNC_PULL_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();

  let kick: ReturnType<typeof setTimeout> | null = null;
  kickers.set(ctx.config, () => {
    if (kick || stopped) return;
    kick = setTimeout(() => {
      kick = null;
      void tick();
    }, SYNC_PULL_KICK_DEBOUNCE_MS);
    if (typeof kick.unref === 'function') kick.unref();
  });
  return () => {
    stopped = true;
    clearInterval(handle);
    if (kick) clearTimeout(kick);
    kickers.delete(ctx.config);
  };
}
