import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Database } from 'better-sqlite3';
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
import { sqliteDriver, type SqliteDriver } from './db/sqliteDriver.js';
import { openTraceDriver } from './db/traceDb.js';
import { startFootprintSampler } from './footprint/sampler.js';
import { log, redactPath } from './log.js';
import { startReaper } from './presence/reaper.js';
import { reconcileAll } from './projection/reconcile.js';
import { startRosterWatcher } from './projection/watcher.js';
import { startSeedsIngest } from './seeds/ingest.js';
import { appendAudit } from './store/audit.js';
import { countDiversityFlagsByTeam } from './store/mast.js';
import { startExpiredMemberSweep } from './store/members.js';
import { countOpenLoopsByTeam } from './store/messages.js';
import { activePresenceBySurface, slowestInboxLagMs } from './store/metrics.js';
import { closeReportService } from './store/reportCache.js';
import { defaultArchiveDir, startAuditRetention } from './store/retention.js';
import { revokeExpiredMember } from './store/sponsoredCascade.js';
import { startTraceContentPrune } from './store/trace.js';
import { startTraceCoverageSweep } from './store/traceCoverage.js';
import { startSyncPull } from './sync/pull.js';
import { startSyncPush } from './sync/push.js';
import { startTracePush } from './sync/tracePush.js';
import { registerRuntimeGauges, startTelemetry, telemetryEnabled } from './telemetry.js';
import { handleHttp } from './transport/http.js';
import { Hub } from './transport/hub.js';
import { broadcastReconciled } from './transport/memberAdded.js';
import { startProvisionSweep, sweepProvisionsPass } from './transport/sponsoredAgentMint.js';
import { attachWsServer } from './transport/ws.js';

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
  /** Serve a built web UI from this directory, same-origin (ADR 062). Defaults to MUSTERD_WEB_ROOT. */
  webRoot?: string;
  /** Inject a database (e.g. an in-memory one) for tests; bypasses dbPath. */
  db?: Database | Driver;
  /** Inject the trace store (ADR 445 §3) for tests; bypasses traceDbPath. With `db` injected and
   *  this absent, the trace store opens in memory — a test never writes a real `trace.db`. */
  traceDb?: Database | Driver;
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
}

export interface RunningServer {
  listen: () => Promise<{ port: number; host: string }>;
  /** Re-resolve roster roots + reconcile + re-point the watcher (ADR 058). Wired to SIGHUP by the bin. */
  reload: () => Promise<void>;
  close: () => Promise<void>;
  /** The raw better-sqlite3 handle, for SQLite-backed tests only; throws when the store is Postgres. */
  db: Database;
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
  /** One provision sweep pass now (ADR 463 §2) — the 60 s loop's body, for tests. */
  runProvisionSweep: (now?: number) => Promise<number>;
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
          ...(opts.cloudPools ? { pools: opts.cloudPools.trace } : {}),
        })
      : openTraceDriver(opts.db ? ':memory:' : config.traceDbPath);
  config.traceDbPath =
    sqliteHandle(traceDb)?.name ?? (traceDb.dialect === 'sqlite' ? config.traceDbPath : 'postgres');
  const hub = new Hub();
  // Durable roster roots (ADR 058): explicit list (tests) or the rosterHome registry + env override.
  // An explicit list is fixed (hermetic tests); otherwise `reload()` re-resolves from the registry so
  // a team exported after the daemon started is picked up without a restart.
  const rootsExplicit = opts.rosterRoots !== undefined;
  const ctx: Ctx = {
    db,
    traceDb,
    hub,
    config,
    rosterRoots: opts.rosterRoots ?? resolveRosterRoots(),
  };
  // Spec §12.1: the transports scope `ctx` per request/connection; everything the daemon does on its
  // own behalf — the loops, telemetry, reconcile, the sweeps — is about every team and runs as the
  // operator. On SQLite these are the same handles.
  const opCtx = operatorCtx(ctx);
  const opDb = opCtx.db;
  const opTraceDb = opCtx.traceDb;

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
    res.on('finish', () => {
      const status = res.statusCode;
      if (path === '/health' && status < 400) return;
      const fields = {
        msg: 'http_request',
        method: req.method ?? 'GET',
        path,
        status,
        ms: Date.now() - t0,
      };
      if (status >= 500) log.error(fields);
      else if (status >= 400) log.warn(fields);
      else log.info(fields);
    });
    void (await handleHttp(ctx, req, res));
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
  let stopReaper: (() => void) | null = null;
  let stopSeeds: (() => void) | null = null;
  let stopSync: (() => void) | null = null;
  let stopPull: (() => void) | null = null;
  let stopFootprint: (() => void) | null = null;
  let stopTracePrune: (() => void) | null = null;
  let stopAuditRetention: (() => void) | null = null;
  let stopTraceCoverage: (() => void) | null = null;
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
    get traceDb() {
      return rawHandle(traceDb, 'traceDb');
    },
    store: opDb,
    traceStore: opTraceDb,
    runProvisionSweep: (now?: number) => sweepProvisionsPass(opCtx, now),
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
      if (ctx.rosterRoots.length > 0) {
        const summary = await reconcileAll(opDb, ctx.rosterRoots);
        log.info({ msg: 'reconcile_boot', teams: summary.length, roots: ctx.rosterRoots.length });
      }
      return await new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, async () => {
          const addr = http.address();
          boundPort = typeof addr === 'object' && addr ? addr.port : config.port;
          stopReaper = startReaper(opCtx);
          stopSeeds = startSeedsIngest(opCtx);
          stopSync = startSyncPush(opCtx);
          stopPull = startSyncPull(opCtx);
          // ADR 453 §4: its own loop, so a stalled /sync/trace never delays /sync/push.
          stopTracePush = startTracePush(opCtx);
          stopFootprint = startFootprintSampler(opCtx);
          // ADR 445 increment 3a: content past its window is nulled, structural rows stay; the
          // window is config (ADR 478 §3: 7 days locally).
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
          stopAuditRetention = startAuditRetention(
            opDb,
            {
              archiveDir: defaultArchiveDir(config.dbPath),
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
                    archive: defaultArchiveDir(config.dbPath),
                  },
                });
              }
            },
            (err) => log.warn({ msg: 'audit_prune_failed', err: String(err) }),
          );
          // ADR 445 §Observability: a quiet session below 0.98 tool coverage is audited, once.
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
              if (swept.length > 0) log.info({ msg: 'expired_members_swept', count: swept.length });
            },
            (err) => log.warn({ msg: 'expired_sweep_failed', err: String(err) }),
          );
          // ADR 463 §2: a provision that can no longer finish hands the sponsor a connect link.
          stopProvisionSweep = await startProvisionSweep(opCtx, (err) =>
            log.warn({ msg: 'provision_sweep_failed', err: String(err) }),
          );
          await startWatching();
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
      if (!rootsExplicit) ctx.rosterRoots = resolveRosterRoots();
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
        stopReaper?.();
        stopSeeds?.();
        stopSync?.();
        stopPull?.();
        stopFootprint?.();
        stopTracePrune?.();
        stopAuditRetention?.();
        stopTraceCoverage?.();
        stopExpiredSweep?.();
        stopProvisionSweep?.();
        stopTracePush?.();
        stopWatcher?.();
        void stopTelemetry?.();
        void closeReportService(db);
        // Kill the upgraded sockets FIRST — http.close() below never settles while they live.
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
export { DriverError } from './db/driver.js';
export { sqliteDriver, type SqliteDriver } from './db/sqliteDriver.js';
// The machine's node credentials (ADR 328 §2) — exported so the CLI's tests can assert what the
// daemon wrote. The CLI never reads or writes this file itself: the daemon owns it.
export { nodeStatePath, readNodeState } from './node/state.js';
export { seedDawn } from './db/seed.js';
