import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  SYNC_STREAM_DEAD_AFTER_MS,
  SYNC_STREAM_PING_MS,
  SyncStreamFrameSchema,
  type SyncStreamFrame,
} from '@musterd/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { checkUpgrade } from '../config.js';
import { operatorCtx, teamCtx, type Ctx } from '../context.js';
import { log } from '../log.js';
import { authenticateNode, touchNode } from '../store/nodes.js';
import { requireTeam } from '../store/teams.js';

/**
 * ADR 552, hub side: the doorbell. A joiner opens `GET /teams/:slug/sync/stream` (WebSocket upgrade,
 * `msnode_` machine credential, the same admission `/sync/pull` has); the hub rings every open
 * stream for a team when `ingestBatch` stages events. A `head` frame is a poke, never the data — the
 * joiner answers it with the pull it already runs, so the fold keeps one implementation.
 */

const STREAM_PATH = /^\/teams\/([^/]+)\/sync\/stream$/;

interface Stream {
  ws: WebSocket;
  nodeId: string;
  /** Last inbound frame (a pong or any other); the reaper drops a stream silent past the budget. */
  lastSeen: number;
}

/**
 * Open streams by team id. In-memory by design (ADR 552 §3): a restart drops them and every joiner
 * reconnects. Keyed by team id alone — a joiner daemon never accepts a stream, so a process holding
 * both a hub and a joiner (the two-daemon tests) never has two registries for one team.
 */
const streams = new Map<string, Set<Stream>>();

/** Is this upgrade path the sync stream? `/ws`'s upgrade handler must leave it alone. */
export function isSyncStreamPath(pathname: string): boolean {
  return STREAM_PATH.test(pathname);
}

function sendFrame(ws: WebSocket, frame: SyncStreamFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/**
 * Ring every open stream for the team: the hub's log is now at `seq`. Never throws and never waits —
 * it runs on the ingest path after the batch has committed, and a joiner that misses a poke has the
 * 60 s tick.
 */
export function ringStreams(teamId: string, seq: number): number {
  const open = streams.get(teamId);
  if (!open || open.size === 0) return 0;
  let rang = 0;
  for (const stream of open) {
    try {
      sendFrame(stream.ws, { type: 'head', seq });
      rang += 1;
    } catch (error) {
      log.warn({ msg: 'sync_stream_ring_failed', team: teamId, error: String(error) });
    }
  }
  return rang;
}

/** Open-stream count for a team (tests and `/health`-style probes). */
export function streamCount(teamId: string): number {
  return streams.get(teamId)?.size ?? 0;
}

function refuse(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Accept stream upgrades on the daemon's HTTP server. Returns `close()`, which terminates every open
 * stream so a held socket never delays a graceful shutdown (`wss.close()` in `createServer().close()`
 * cannot reach these — they live on their own `noServer` instance).
 */
export function attachSyncStream(rootCtx: Ctx, server: Server): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  const opCtx = operatorCtx(rootCtx);
  /** This server's own streams: close() and the reaper touch only these, never another server's. */
  const mine = new Set<Stream>();

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const stream of mine) {
      if (now - stream.lastSeen > SYNC_STREAM_DEAD_AFTER_MS) {
        log.info({ msg: 'sync_stream_close', node: stream.nodeId, reason: 'ping_timeout' });
        stream.ws.terminate();
      } else {
        sendFrame(stream.ws, { type: 'ping' });
      }
    }
  }, SYNC_STREAM_PING_MS);
  if (typeof reaper.unref === 'function') reaper.unref();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = STREAM_PATH.exec(url.pathname);
    if (!match) return; // `/ws` (or a destroy) is attachWsServer's call
    void admit(decodeURIComponent(match[1]!), req, socket, head);
  });

  async function admit(slug: string, req: IncomingMessage, socket: Duplex, head: Buffer) {
    const check = checkUpgrade(
      { host: req.headers.host, origin: req.headers.origin },
      {
        boundHost: rootCtx.config.host,
        allowedHosts: rootCtx.config.allowedHosts,
        allowedOrigins: rootCtx.config.allowedOrigins,
        hostSuffix: rootCtx.config.cloud?.hostSuffix ?? null,
      },
    );
    if (!check.ok) return refuse(socket, '403 Forbidden');
    // Cloud teams have no joiners (`loopsFor` excludes sync): nothing to admit.
    if (rootCtx.config.cloud) return refuse(socket, '404 Not Found');
    try {
      const team = await requireTeam(opCtx.db, slug);
      const ctx = teamCtx(rootCtx, team.id);
      const header = req.headers['authorization'];
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      const node = await authenticateNode(ctx.db, team.id, token);
      if (!node) return refuse(socket, '401 Unauthorized');
      await touchNode(ctx.db, node.id, Date.now());
      wss.handleUpgrade(req, socket, head, (ws) => open(team.id, node.id, ws));
    } catch (error) {
      // Same answer as an unknown team, so the endpoint does not probe which teams exist.
      log.warn({ msg: 'sync_stream_refused', error: String(error) });
      refuse(socket, '404 Not Found');
    }
  }

  function open(teamId: string, nodeId: string, ws: WebSocket) {
    const stream: Stream = { ws, nodeId, lastSeen: Date.now() };
    let set = streams.get(teamId);
    if (!set) streams.set(teamId, (set = new Set()));
    set.add(stream);
    mine.add(stream);
    log.info({ msg: 'sync_stream_open', team: teamId, node: nodeId });
    ws.on('message', (data: RawData) => {
      stream.lastSeen = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        log.warn({ msg: 'sync_stream_bad_frame', node: nodeId });
        return;
      }
      const frame = SyncStreamFrameSchema.safeParse(parsed);
      if (!frame.success) {
        log.warn({ msg: 'sync_stream_bad_frame', node: nodeId });
        return;
      }
      // A pong proves the socket, not the node's work (ADR 552 §6): no touchNode here.
      if (frame.data.type === 'ping') sendFrame(ws, { type: 'pong' });
    });
    const drop = () => {
      mine.delete(stream);
      set.delete(stream);
      if (set.size === 0 && streams.get(teamId) === set) streams.delete(teamId);
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  return {
    close() {
      clearInterval(reaper);
      for (const stream of mine) stream.ws.terminate();
      wss.close();
    },
  };
}
