import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Envelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { Affinity, affinityFromEnv, type AffinityOptions } from './cloud/affinity.js';
import { loopsFor } from './cloud/loops.js';
import {
  RECONCILE_DEBOUNCE_MS,
  assertBindSecurity,
  resolveConfig,
  resolveRosterRoots,
} from './config.js';
import { operatorCtx, type Ctx } from './context.js';
import type { Driver } from './db/driver.js';
import { schemaVersionOf } from './db/migrations.js';
import { openDriver } from './db/open.js';
import { assertSchemaCurrent } from './db/pg/migrate.js';
import { pgDriver, type PoolFactory } from './db/pgDriver.js';
import { endRequestTiming, withRequestTiming } from './db/requestTiming.js';
import { sqliteDriver, type SqliteDriver } from './db/sqliteDriver.js';
import { openTraceDriver } from './db/traceDb.js';
import { startDigestSchedule } from './digest/schedule.js';
import { startFootprintSampler } from './footprint/sampler.js';
import { log, redactPath, requestFailure } from './log.js';
import { startAwayRelay } from './notify/relay.js';
import { startReaper } from './presence/reaper.js';
import { reconcileAll } from './projection/reconcile.js';
import { startRosterWatcher } from './projection/watcher.js';
import { routeEnvelope } from './protocol/route.js';
import { startSeedsIngest } from './seeds/ingest.js';
import { appendAudit } from './store/audit.js';
import { countDiversityFlagsByTeam } from './store/mast.js';
import { startExpiredMemberSweep } from './store/members.js';
import { countOpenLoopsByTeam } from './store/messages.js';
import { activePresenceBySurface, slowestInboxLagMs } from './store/metrics.js';
import { policyReviewTick, startPolicyReviewSweep } from './store/policyReview.js';
import { closeReportService } from './store/reportCache.js';
import { AUDIT_ARCHIVE_TABLE, defaultArchiveDir, startAuditRetention } from './store/retention.js';
import type { MemberRow } from './store/rows.js';
import { revokeExpiredMember } from './store/sponsoredCascade.js';
import { getTeamById, getTeamBySlug } from './store/teams.js';
import { startTraceContentPrune } from './store/trace.js';
import { startTraceCoverageSweep } from './store/traceCoverage.js';
import { startSyncPull } from './sync/pull.js';
import { startSyncPush } from './sync/push.js';
import { makeUnresolvedSeatHook } from './sync/rosterRefresh.js';
import { attachSyncStream } from './sync/streamHub.js';
import { startSyncStream } from './sync/streamJoiner.js';
import { startTracePush } from './sync/tracePush.js';
import { registerRuntimeGauges, startTelemetry, telemetryEnabled } from './telemetry.js';
import { handleHttp } from './transport/http.js';
import { Hub } from './transport/hub.js';
import type { RemoteMcpFactory } from './transport/mcpHttp.js';
import { broadcastReconciled } from './transport/memberAdded.js';
import { SeatPulses } from './transport/seatPulses.js';
import { startProvisionSweep, sweepProvisionsPass } from './transport/sponsoredAgentMint.js';
import { attachWsServer } from './transport/ws.js';

/** A request at least this slow logs its connection fields (lane 01M4S0ZAG8). */
const SLOW_REQUEST_MS = 1_000;

/**
 * The main thread blocked this long is logged (lane 01M4YY5Z38): a timer that fires late by more
 * than this means nothing in the daemon ran — no request, no socket, no loop. On 2026-10-14
 * wake-lease polls waited 1–5 s with no other request finishing in the same window, and no log line
 * said so. The line lands when the stall ends, next to whatever `sqlite_stmt_slow` caused it.
 */
const STALL_TICK_MS = 250;
const STALL_LOG_MS = 500;

function watchEventLoop(): () => void {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const stall = now - last - STALL_TICK_MS;
    last = now;
    if (stall >= STALL_LOG_MS) log.warn({ msg: 'event_loop_stall', stall_ms: Math.round(stall) });
  }, STALL_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export interface ServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  /** Path to a PEM certificate to serve native TLS (wss://); pair with tlsKey (ADR 040). */
  tlsCert?: string;
  /** Path to the PEM private key for tlsCert. */
  tlsKey?: string;
  /** Acknowledge a TLS-terminating proxy/overlay in front, allowing a non-loopback plaintext bind. */
  trustProxy?: boolean;
  /** ADR 662 dec. 5: WebAuthn origins override (tests, hosted origins). */
  webauthnOrigins?: string[];
  /** Serve a built web UI from this directory, same-origin (ADR 062). Defaults to MUSTERD_WEB_ROOT. */
  webRoot?: string;
  /** Inject a database (e.g. an in-memory one) for tests; bypasses dbPath. */
  db?: Database | Driver;
  /** Inject the trace store (ADR 445 §3) for tests; bypasses traceDbPath. With `db` injected and
   *  this absent, the trace store opens in memory — a test never writes a real `trace.db`. */
  traceDb?: Database | Driver;
  /** Tests only: `false` leaves the sync push, pull and trace-push loops (and the doorbell they
   *  carry) unstarted, so a test that drives `pushTeam`/`pullTeam`/`pushTraceTeam` by hand is not
   *  raced by the daemon doing the same — each loop ticks every 60 s, which a slow cold-boot runner
   *  reaches inside one test. Production never passes this. */
  syncLoops?: boolean;
  /** Roster roots to project + watch (ADR 058). Defaults to {@link resolveRosterRoots}; pass an
   * explicit list to keep tests hermetic (no global-config dependency). `[]` disables reconcile. */
  rosterRoots?: string[];
  /** The commit this daemon boots from (ADR 130) — resolved by the embedder; surfaced on /health. */
  buildRef?: string;
  /**
   * Cloud mode only, tests only (1C): the pools `pgDriver` draws connections from, in place of a
   * `pg.Pool` per configured URL — `testCloudPools()` backs them with PGlite. Production never
   * passes this; the URLs in the cloud config are the store.
   */
  cloudPools?: { main: PoolFactory; trace: PoolFactory };
  /** Tests only: the ADR 608 affinity (this machine's id and the peer list) instead of the env's. */
  affinity?: AffinityOptions;
  /**
   * ADR 630 §2: builds the remote MCP server for one `/mcp/:team` request. The server implements
   * no MCP tools of its own and never imports the adapter; `musterd serve` composes this from
   * `@musterd/mcp`. Absent, tool traffic answers 503 "remote MCP not configured" and the OAuth
   * routes still work.
   */
  remoteMcp?: RemoteMcpFactory;
}

export interface RunningServer {
  listen: () => Promise<{ port: number; host: string }>;
  /** Re-resolve roster roots + reconcile + re-point the watcher (ADR 058). Wired to SIGHUP by the bin. */
  reload: () => Promise<void>;
  close: () => Promise<void>;
  /** The raw better-sqlite3 handle, for SQLite-backed tests only; throws when the store is Postgres. */
  db: Database;
  /** The resolved config — the key the sync loops register their doorbells and stops under. */
  config: Ctx['config'];
  /** The trace store (ADR 445 §3) — exposed so tests can read what a hook posted. Same caveat. */
  traceDb: Database;
  /**
   * The store as the OPERATOR sees it (spec §12.1): every team's rows, on either engine. For tests
   * that read back what a request wrote, and for tooling; the daemon's own code never takes this
   * door — its loops receive the same handle through `operatorCtx`.
   */
  readonly store: Driver;
  /** The trace store, operator-scoped. */
  readonly traceStore: Driver;
  /** ADR 660: the seat-pulse rings — exposed so tests can read what a feed produced. */
  readonly pulses: SeatPulses;
  /** One provision sweep pass now (ADR 463 §2) — the 60 s loop's body, for tests. */
  runProvisionSweep: (now?: number) => Promise<number>;
  /** One policy review pass now (ADR 533) — the hourly loop's body, with its real send, for tests. */
  runPolicyReviewSweep: (now?: number) => Promise<number>;
  /** The bound port, available after listen() resolves. */
  readonly port: number;
  /** The resolved database path this daemon serves (diagnostics — which db is live). */
  readonly dbPath: string;
  /** The scheme this listener serves: `wss` with native TLS, else `ws` (ADR 040). */
  readonly scheme: 'ws' | 'wss';
}

/** Construct (but do not start) a musterd server. Call listen() to bind. */
function isDriver(x: Database | Driver): x is Driver {
  return typeof (x as Driver).dialect === 'string' && typeof (x as Driver).tx === 'function';
}

/** The better-sqlite3 connection under a Driver, or null when the store is another dialect. */
const sqliteHandle = (d: Driver): Database | null =>
  d.dialect === 'sqlite' ? (d as SqliteDriver).raw : null;
const rawHandle = (d: Driver, what: string): Database => {
  const h = sqliteHandle(d);
  if (!h)
    throw new Error(`RunningServer.${what} is the SQLite handle; this server's store is Postgres`);
  return h;
};

export function createServer(opts: ServerOptions = {}): RunningServer {
  const config = resolveConfig(opts);
  // Secure by default (ADR 040): never bind beyond loopback in plaintext. Fail fast, before any
  // resource (db, socket) is opened, with guidance on how to widen the bind safely.
  assertBindSecurity({
    host: config.host,
    hasTls: config.tls !== null,
    trustProxy: config.trustProxy,
  });
  // ADR 479: the store is a Driver; a raw better-sqlite3 handle (tests, the CLI) is wrapped here.
  // Cloud mode (spec §5): the store is the configured Postgres — never a file, never a fallback.
  const cloud = config.cloud;
  const db: Driver = opts.db
    ? isDriver(opts.db)
      ? opts.db
      : sqliteDriver(opts.db)
    : cloud
      ? pgDriver({
          appUrl: cloud.databaseAppUrl,
          operatorUrl: cloud.databaseOperatorUrl,
          ...(cloud.pgPoolSize ? { poolSize: cloud.pgPoolSize } : {}),
          ...(opts.cloudPools ? { pools: opts.cloudPools.main } : {}),
        })
      : openDriver(config.dbPath);
  // The handle is the FACT; `config.dbPath` is only the intention, and an injected `opts.db` never
  // opened it. Reconciled here, once, so every reader downstream is honest by construction: the
  // startup log line, the `dbPath` accessor, and `db` on /health — which exists precisely so a
  // client can confirm which database this daemon serves, and which guardian turns into the
  // `wrong_db` alert. In production the two always agreed (`openDb(p)` opens exactly `p`), so the
  // value was accidentally right rather than derived from anything checked.
  // A Postgres store has no file: name it so, rather than the SQLite path config resolved and the
  // daemon never opened (the /health `db` field, the archive dir, the size probes all key on it).
  config.dbPath = sqliteHandle(db)?.name ?? (db.dialect === 'sqlite' ? config.dbPath : 'postgres');
  // The trace store (ADR 445 §3): its own file, its own ladder, opened beside — never inside — the
  // coordination store. An injected `db` with no injected `traceDb` gets an in-memory trace store,
  // so a test that hands us `:memory:` never leaves a `trace.db` on disk.
  const traceDb: Driver = opts.traceDb
    ? isDriver(opts.traceDb)
      ? opts.traceDb
      : sqliteDriver(opts.traceDb)
    : cloud && !opts.db
      ? pgDriver({
          appUrl: cloud.traceDatabaseAppUrl,
          operatorUrl: cloud.traceDatabaseOperatorUrl,
          ...(cloud.pgPoolSize ? { poolSize: cloud.pgPoolSize } : {}),
          ...(opts.cloudPools ? { pools: opts.cloudPools.trace } : {}),
        })
      : openTraceDriver(opts.db ? ':memory:' : config.traceDbPath);
  config.traceDbPath =
    sqliteHandle(traceDb)?.name ?? (traceDb.dialect === 'sqlite' ? config.traceDbPath : 'postgres');
  const hub = new Hub();
  // ADR 660: the seat pulse rings each seat's last minute of tool calls and pushes a coalesced frame.
  const pulses = new SeatPulses({
    now: Date.now,
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    },
    push: (teamId, frame) => hub.broadcastFirehose(teamId, frame),
  });
  // ADR 608: on Cloud under Fly, one server owns a team at a time; a lost team's sockets are closed
  // so their clients reconnect through the proxy to the new owner. Off (null) off Cloud.
  const affinity = cloud
    ? new Affinity({
        ...(opts.affinity ?? affinityFromEnv(process.env)),
        onChange: (ownerOf) => {
          // Walk the teams this server holds sockets for (by id) and close those it no longer
          // owns (by slug). Resolved as the operator, which `opDb` below is; the closure runs on
          // a timer, long after it is assigned.
          void (async () => {
            for (const teamId of hub.teamIds()) {
              const team = await getTeamById(opDb, teamId).catch(() => null);
              if (!team) continue;
              const owner = ownerOf(team.slug);
              if (owner === affinity?.self) continue;
              const closed = hub.closeTeam(teamId);
              log.info({ msg: 'affinity_lost', team: team.slug, closed, owner });
            }
          })();
        },
      })
    : null;
  // Durable roster roots (ADR 058): explicit list (tests) or the rosterHome registry + env override.
  // An explicit list is fixed (hermetic tests); otherwise `reload()` re-resolves from the registry so
  // a team exported after the daemon started is picked up without a restart.
  const rootsExplicit = opts.rosterRoots !== undefined;
  const ctx: Ctx = {
    db,
    traceDb,
    hub,
    pulses,
    affinity,
    config,
    rosterRoots: opts.rosterRoots ?? resolveRosterRoots(),
    remoteMcp: opts.remoteMcp,
  };
  // Spec §12.1: the transports scope `ctx` per request/connection; everything the daemon does on its
  // own behalf — the loops, telemetry, reconcile, the sweeps — is about every team and runs as the
  // operator. On SQLite these are the same handles.
  const opCtx = operatorCtx(ctx);
  const opDb = opCtx.db;
  // ADR 592: a fold stopped on an unknown seat pulls the roster roots itself and reconciles —
  // wired on the operator ctx the sync loops run under, because reconcile is about every team.
  // A test that passes `rosterRoots: []` gets a hook that answers false at once.
  opCtx.onUnresolvedSeat = makeUnresolvedSeatHook(opCtx);
  // The hub's claim arbitration runs on the request ctx and pulls on an unknown seat too (lane
  // 01M4S7N1HV); same hook, same per-seat rate limit, so a fold and a claim never double the pulls.
  ctx.onUnresolvedSeat = opCtx.onUnresolvedSeat;
  // ADR 533: how the policy review ask is stored and delivered — the daemon's route, daemon-composed.
  const policyReviewSend = async (from: MemberRow, env: Envelope) => {
    const team = (await getTeamBySlug(opDb, env.team))!;
    return (await routeEnvelope(opCtx, team, from, env, undefined, true)).message;
  };
  const opTraceDb = opCtx.traceDb;
  const loops = new Set(loopsFor(config.mode));
  if (opts.syncLoops === false)
    for (const name of ['sync_push', 'sync_pull', 'trace_push'] as const) loops.delete(name);

  // Lane 01M4S0ZAG8: per keep-alive socket, how many requests it has carried and when the last one
  // finished. A slow line reads them to say whether the time was the connection's (an idle socket
  // the server was about to drop, a body that came late) rather than the handler's.
  const sockets = new WeakMap<object, { requests: number; lastFinish: number | null }>();
  const handler = async (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => {
    // HTTP request log (ADR 082 slice 2): method/path/status/latency on every request — the layer
    // finding 001 flagged as absent. Path only, never query/headers, and the path itself redacted
    // (a remote MCP connector URL carries its secret there — hard rule 5); healthy /health polls are
    // skipped (the CLI guard polls it — it would drown the log). warn on 4xx, error on 5xx.
    const t0 = Date.now();
    const path = redactPath((req.url ?? '/').split('?')[0]!);
    const socket = sockets.get(req.socket) ?? { requests: 0, lastFinish: null };
    sockets.set(req.socket, socket);
    socket.requests += 1;
    const sockReq = socket.requests;
    const sockIdleMs = socket.lastFinish === null ? null : t0 - socket.lastFinish;
    let bodyEnd: number | null = null;
    req.once('end', () => (bodyEnd = Date.now()));
    res.on('finish', () => {
      const now = Date.now();
      socket.lastFinish = now;
      const status = res.statusCode;
      if (path === '/health' && status < 400) return;
      const failure = requestFailure(res);
      const ms = now - t0;
      const fields = {
        msg: 'http_request',
        method: req.method ?? 'GET',
        path,
        status,
        ms,
        // Only on a slow line, where the question is whether the connection held it.
        ...(ms >= SLOW_REQUEST_MS
          ? {
              sock_req: sockReq,
              sock_idle_ms: sockIdleMs,
              body_ms: bodyEnd === null ? null : bodyEnd - t0,
            }
          : undefined),
        // Where the store time went (lane 01M3Z455NE): every Postgres request that touched the
        // store; on SQLite (queue wait and hold, no query time) only on a slow line (lane
        // 01M4S0ZAG8), since the queue is the question there and fast lines would just grow.
        ...((run.timing.tx > 0 || run.timing.waitMs > 0) &&
        (run.timing.queryMs > 0 || ms >= SLOW_REQUEST_MS)
          ? {
              db_tx: run.timing.tx,
              db_stmt: run.timing.stmt,
              db_wait_ms: Math.round(run.timing.waitMs),
              db_hold_ms: Math.round(run.timing.holdMs),
              db_query_ms: Math.round(run.timing.queryMs),
            }
          : undefined),
        // Why a 5xx happened, or a remote-MCP tool error carried in an HTTP 200 result.
        ...(failure ?? undefined),
      };
      if (status >= 500 || failure) log.error(fields);
      else if (status >= 400) log.warn(fields);
      else log.info(fields);
    });
    // The store records into this request's timing (db/requestTiming.ts); read at 'finish'.
    const run = withRequestTiming(() => handleHttp(ctx, req, res));
    // ADR 507: the request's leased store clients go back when the response is done ('close'
    // fires after 'finish' and on an aborted connection alike).
    res.once('close', () => void endRequestTiming(run.timing));
    void (await run.result);
  };
  const http: Server = config.tls
    ? (createHttpsServer(
        { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) },
        handler,
      ) as unknown as Server)
    : createHttpServer(handler);
  // Keep the handle: `close()` MUST be able to terminate live WS clients. Discarding it is what hung
  // the daemon on 2026-07-27 — see the close() comment below.
  const wss = attachWsServer(ctx, http);
  const syncStream = attachSyncStream(ctx, http);
  const stopLoopWatch = watchEventLoop();
  let stopReaper: (() => void) | null = null;
  let stopSeeds: (() => void) | null = null;
  let stopAwayRelay: (() => void) | null = null;
  let stopDigest: (() => void) | null = null;
  let stopSync: (() => void) | null = null;
  let stopPull: (() => void) | null = null;
  let stopStream: (() => void) | null = null;
  let stopFootprint: (() => void) | null = null;
  let stopTracePrune: (() => void) | null = null;
  let stopAuditRetention: (() => void) | null = null;
  let stopTraceCoverage: (() => void) | null = null;
  let stopPolicyReview: (() => void) | null = null;
  let stopExpiredSweep: (() => void) | null = null;
  let stopProvisionSweep: (() => void) | null = null;
  let stopTracePush: (() => void) | null = null;
  let stopWatcher: (() => void) | null = null;
  let stopTelemetry: (() => Promise<void>) | null = null;
  /** One shared shutdown promise, so a second signal joins the first instead of racing it. */
  let closing: Promise<void> | null = null;
  let boundPort = config.port;

  // (Re)start the roster watcher for the current `ctx.rosterRoots`. Reused by listen() and reload().
  const startWatching = async () => {
    stopWatcher?.();
    stopWatcher = null;
    if (ctx.rosterRoots.length > 0) {
      stopWatcher = startRosterWatcher(ctx.rosterRoots, RECONCILE_DEBOUNCE_MS, async () => {
        // A seat file that just appeared (a git pull, `musterd agent`) is a Member arriving — say so.
        void (await reconcileAll(opDb, ctx.rosterRoots)
          .then((r) => broadcastReconciled(ctx, r))
          .catch((err) => log.warn({ msg: 'reconcile_watch_failed', err: String(err) })));
      });
    }
  };

  return {
    // The raw handles, for the CLI's server-side tests (they open the store themselves and read it
    // back through `server.db.prepare`); the daemon's own code never takes this door.
    get db() {
      return rawHandle(db, 'db');
    },
    get config() {
      return config;
    },
    get traceDb() {
      return rawHandle(traceDb, 'traceDb');
    },
    store: opDb,
    traceStore: opTraceDb,
    pulses,
    runProvisionSweep: (now?: number) => sweepProvisionsPass(opCtx, now),
    runPolicyReviewSweep: (now?: number) => policyReviewTick(opDb, now, policyReviewSend),
    get port() {
      return boundPort;
    },
    get dbPath() {
      return config.dbPath;
    },
    get scheme() {
      return config.scheme;
    },
    async listen() {
      // Cloud (spec §6): migrations are a separate step; a server whose database is not at exactly
      // its own schema version refuses to start, before it binds or starts a loop.
      if (config.cloud && opDb.dialect === 'postgres') {
        await assertSchemaCurrent(opDb, 'main');
        await assertSchemaCurrent(opTraceDb, 'trace');
      }
      // Start telemetry before binding so the first envelope is already instrumented. No-op + instant
      // when no OTLP endpoint is configured (off by default — observability.md §4 / ADR 015).
      stopTelemetry = await startTelemetry();
      if (telemetryEnabled()) {
        registerRuntimeGauges({
          presenceBySurface: () => activePresenceBySurface(opDb, config.presenceTimeoutMs),
          inboxLagMs: () => slowestInboxLagMs(opDb),
          openLoopsByTeam: async () => await countOpenLoopsByTeam(opDb),
          diversityFlagsByTeam: async () => await countDiversityFlagsByTeam(opDb),
        });
      }
      // Boot floor (ADR 058): project the durable files into the db before serving, so the roster the
      // first request sees matches git. Idempotent — safe to re-run; the watcher takes over at runtime.
      if (loops.has('roster_watch') && ctx.rosterRoots.length > 0) {
        const summary = await reconcileAll(opDb, ctx.rosterRoots);
        log.info({ msg: 'reconcile_boot', teams: summary.length, roots: ctx.rosterRoots.length });
      }
      return await new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, async () => {
          const addr = http.address();
          boundPort = typeof addr === 'object' && addr ? addr.port : config.port;
          // Cloud runs only the loops that are about the database (cloud/loops.ts names the rest).
          if (loops.has('reaper')) stopReaper = startReaper(opCtx);
          affinity?.start();
          if (loops.has('seeds_ingest')) stopSeeds = startSeedsIngest(opCtx);
          // ADR 659: the away-relay client. Inert unless a team's policy names a relay.
          if (loops.has('away_relay')) stopAwayRelay = startAwayRelay(opCtx);
          // ADR 494 §5: the morning digest, posted at each team's working-hours start.
          if (loops.has('digest')) stopDigest = startDigestSchedule(opCtx);
          if (loops.has('sync_push')) stopSync = startSyncPush(opCtx);
          if (loops.has('sync_pull')) {
            stopPull = startSyncPull(opCtx);
            // ADR 552: the hub's doorbell. The 60 s tick above stays the floor.
            stopStream = startSyncStream(opCtx);
          }
          // ADR 453 §4: its own loop, so a stalled /sync/trace never delays /sync/push.
          if (loops.has('trace_push')) stopTracePush = startTracePush(opCtx);
          if (loops.has('footprint')) stopFootprint = startFootprintSampler(opCtx);
          // ADR 445 increment 3a: content past its window is nulled, structural rows stay; the
          // window is config (ADR 478 §3: 7 days locally).
          if (loops.has('trace_prune'))
            stopTracePrune = startTraceContentPrune(
              opTraceDb,
              (r) => {
                if (r.pruned > 0)
                  log.info({
                    msg: 'trace_content_pruned',
                    rows: r.pruned,
                    cutoff: r.cutoff,
                    captured_through: r.capturedThrough,
                  });
              },
              (err) => log.warn({ msg: 'trace_prune_failed', err: String(err) }),
              { maxAgeMs: config.traceContentRetentionMs },
            );
          // ADR 478 §1/§5: churn-class audit rows past their window are archived, then pruned, daily;
          // an in-memory store has no archive dir and is skipped. One `store.pruned` row per team.
          // Cloud archives into the `audit_archive` table instead (ADR 478 amendment, 2026-10-15):
          // the VM's disk is ephemeral, the database is not.
          const archiveTable = config.mode === 'cloud';
          const archive = archiveTable ? AUDIT_ARCHIVE_TABLE : defaultArchiveDir(config.dbPath);
          if (loops.has('audit_retention'))
            stopAuditRetention = startAuditRetention(
              opDb,
              {
                archiveDir: defaultArchiveDir(config.dbPath),
                archiveTable,
                maxAgeMs: config.auditChurnRetentionMs,
              },
              async (r) => {
                if (r.pruned === 0) return;
                log.info({
                  msg: 'audit_churn_pruned',
                  rows: r.pruned,
                  bytes: r.archivedBytes,
                  cutoff: r.cutoff,
                });
                for (const [teamId, rows] of Object.entries(r.perTeam)) {
                  await appendAudit(opDb, teamId, {
                    actor: null,
                    action: 'store.pruned',
                    target: null,
                    result: 'allow',
                    detail: {
                      class: 'audit_churn',
                      rows,
                      bytes: r.archivedBytes,
                      archive,
                    },
                  });
                }
              },
              (err) => log.warn({ msg: 'audit_prune_failed', err: String(err) }),
            );
          // ADR 533: a stored policy doc past its review_by asks the human admins once, as the
          // `policy` service seat; hub only, since policy is hub-authoritative.
          if (loops.has('policy_review'))
            stopPolicyReview = startPolicyReviewSweep(opDb, policyReviewSend, (err) =>
              log.warn({ msg: 'policy_review_sweep_failed', err: String(err) }),
            );
          // ADR 445 §Observability: a quiet session below 0.98 tool coverage is audited, once.
          if (loops.has('trace_coverage'))
            stopTraceCoverage = startTraceCoverageSweep(
              opDb,
              opTraceDb,
              async (sessions) => {
                for (const s of sessions) {
                  await appendAudit(opDb, s.team_id, {
                    actor: null,
                    action: 'trace.coverage_low',
                    target: s.seat,
                    result: 'allow',
                    detail: {
                      harness: s.harness,
                      session_digest: s.session_digest,
                      post_tool_use: s.post_tool_use,
                      r2_tool_uses: s.r2_tool_uses,
                      coverage: s.coverage,
                    },
                  });
                }
              },
              (err) => log.warn({ msg: 'trace_coverage_sweep_failed', err: String(err) }),
            );
          // ADR 459 §4: expired members read as departed on the roster. Hygiene only — auth
          // already refused them — so one audited row per swept member, and a failing pass logs on.
          if (loops.has('expired_member_sweep'))
            stopExpiredSweep = await startExpiredMemberSweep(
              opDb,
              async (swept) => {
                for (const m of swept) {
                  await appendAudit(opDb, m.team_id, {
                    actor: null,
                    action: 'member.expired_swept',
                    target: m.name,
                    result: 'allow',
                    detail: { lifecycle_until: m.lifecycle_until },
                  });
                  // ADR 463 §4.4: expiry takes the enrollment and anything the member sponsored.
                  await revokeExpiredMember(opDb, m.team_id, m);
                }
                if (swept.length > 0)
                  log.info({ msg: 'expired_members_swept', count: swept.length });
              },
              (err) => log.warn({ msg: 'expired_sweep_failed', err: String(err) }),
            );
          // ADR 463 §2: a provision that can no longer finish hands the sponsor a connect link.
          if (loops.has('provision_sweep'))
            stopProvisionSweep = await startProvisionSweep(opCtx, (err) =>
              log.warn({ msg: 'provision_sweep_failed', err: String(err) }),
            );
          if (loops.has('roster_watch')) await startWatching();
          log.info({
            msg: 'listening',
            host: config.host,
            port: boundPort,
            scheme: config.scheme,
            trustProxy: config.trustProxy,
            db: config.dbPath,
            schema: await schemaVersionOf(opDb),
          });
          resolve({ port: boundPort, host: config.host });
        });
      });
    },
    async reload() {
      // Re-resolve roster roots from the registry (a team may have been exported since boot), then
      // re-reconcile and re-point the watcher. Explicit (test) roots are fixed and not re-resolved.
      // Wired to SIGHUP by the daemon bin — the lib never grabs process signals (tests would clash).
      if (!loops.has('roster_watch')) return; // Cloud: no roster files to re-read
      if (!rootsExplicit) ctx.rosterRoots = resolveRosterRoots();
      // `opCtx` is a copy taken at boot; its roots feed the ADR 592 pull hook, which would
      // otherwise never pull a roster exported after the daemon started.
      opCtx.rosterRoots = ctx.rosterRoots;
      const summary = await reconcileAll(opDb, ctx.rosterRoots);
      await broadcastReconciled(ctx, summary);
      await startWatching();
      log.info({ msg: 'reconcile_reload', teams: summary.length, roots: ctx.rosterRoots.length });
    },
    /**
     * Stop the daemon. **Must always complete**, including with agents connected — on 2026-07-27 it
     * did not, and the whole team's coordination layer stayed down with no auto-recovery: the process
     * survived SIGTERM, so launchd's KeepAlive never fired and every sanctioned bounce path
     * (`service restart`/`refresh`, the 2-minute auto-refresher) could wedge it.
     *
     * The trap: `http.closeAllConnections()` cannot reach a WebSocket. `ws` runs in `noServer` mode
     * behind an `upgrade` listener, and Node **detaches** an upgraded socket from the HTTP server's
     * connection tracking — so those sockets are the WS server's to close, and `http.close()` waits
     * on them forever if nobody does. Terminating the clients is therefore not a tidy-up, it is the
     * thing that lets the process exit.
     *
     * Idempotent: production saw two `SIGTERM`s land, the second while the first close was pending.
     */
    close() {
      if (closing) return closing;
      closing = new Promise((resolve) => {
        stopLoopWatch();
        stopReaper?.();
        affinity?.stop();
        stopSeeds?.();
        stopAwayRelay?.();
        pulses.dispose();
        stopDigest?.();
        stopSync?.();
        stopPull?.();
        stopStream?.();
        stopFootprint?.();
        stopTracePrune?.();
        stopAuditRetention?.();
        stopTraceCoverage?.();
        stopPolicyReview?.();
        stopExpiredSweep?.();
        stopProvisionSweep?.();
        stopTracePush?.();
        stopWatcher?.();
        void stopTelemetry?.();
        void closeReportService(db);
        // Kill the upgraded sockets FIRST — http.close() below never settles while they live.
        syncStream.close();
        for (const client of wss.clients) client.terminate();
        wss.close();
        http.close(() => {
          if (!opts.db) db.close();
          if (!opts.traceDb) traceDb.close();
          resolve();
        });
        // Force-close lingering keep-alive (non-upgraded) sockets so tests exit promptly.
        http.closeAllConnections?.();
      });
      return closing;
    },
  };
}

export { resolveConfig } from './config.js';
export { openDb, openDriver } from './db/open.js';
export type { Driver, Params } from './db/driver.js';
// ADR 630: the seam `musterd serve` composes the remote MCP through.
export type { RemoteMcpFactory, RemoteMcpSeat } from './transport/mcpHttp.js';
export { DriverError } from './db/driver.js';
export { sqliteDriver, type SqliteDriver } from './db/sqliteDriver.js';
// The machine's node credentials (ADR 328 §2) — exported so the CLI's tests can assert what the
// daemon wrote. The CLI never reads or writes this file itself: the daemon owns it.
export { nodeStatePath, readNodeState } from './node/state.js';
export { seedDawn } from './db/seed.js';
