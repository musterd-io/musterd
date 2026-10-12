import { SyncStreamFrameSchema } from '@musterd/protocol';
import WebSocket from 'ws';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { readNodeState } from '../node/state.js';
import { listActiveTeams } from '../store/teams.js';
import { readPullCursor } from './fold.js';
import { kickSyncPull } from './pull.js';

/**
 * ADR 552, joiner side: hold one WebSocket to the hub per enrolled team and turn each `head` poke
 * into the pull the joiner already runs. The 60 s tick in `startSyncPull` stays the floor — a hub
 * that predates the stream (404 on the upgrade), a proxy that refuses it, or a dropped socket all
 * degrade to polling with no flag.
 */

export const SYNC_STREAM_BACKOFF_MIN_MS = 1_000;
export const SYNC_STREAM_BACKOFF_MAX_MS = 30_000;
/** How often the joiner looks for teams newly enrolled (or re-enrolled) since it last looked. */
const SYNC_STREAM_RESCAN_MS = 15_000;

/** The scan to run now, per database: enrolling a node must not wait for the next rescan. */
const scanners = new WeakMap<Ctx['db'], () => void>();

/** Look for enrollment changes now (called after `/node/enroll`). Never throws, never blocks. */
export function kickSyncStream(ctx: Ctx): void {
  scanners.get(ctx.db)?.();
}

/** `http(s)://hub/…` → `ws(s)://hub/teams/<slug>/sync/stream`. */
export function streamUrl(hubUrl: string, slug: string): URL {
  const url = new URL(`/teams/${slug}/sync/stream`, hubUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

/** Exponential backoff with full jitter, bounded; `attempt` counts consecutive failures from 0. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(SYNC_STREAM_BACKOFF_MAX_MS, SYNC_STREAM_BACKOFF_MIN_MS * 2 ** attempt);
  return Math.round(SYNC_STREAM_BACKOFF_MIN_MS + random() * (ceiling - SYNC_STREAM_BACKOFF_MIN_MS));
}

interface Link {
  hubUrl: string;
  credential: string;
  stop: () => void;
}

/** Start the stream client. Returns a stop function (same contract as startSyncPull). */
export function startSyncStream(ctx: Ctx): () => void {
  const links = new Map<string, Link>(); // team slug → live link
  let stopped = false;

  const open = (slug: string, teamId: string, hubUrl: string, credential: string): Link => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let down = false; // logged `sync_stream_down` for this outage already
    let closed = false;

    const schedule = () => {
      if (closed || stopped) return;
      timer = setTimeout(connect, backoffMs(attempt));
      if (typeof timer.unref === 'function') timer.unref();
      attempt += 1;
    };

    const connect = () => {
      timer = null;
      if (closed || stopped) return;
      const socket = new WebSocket(streamUrl(hubUrl, slug), {
        headers: { authorization: `Bearer ${credential}` },
        handshakeTimeout: 10_000,
      });
      ws = socket;
      socket.on('open', () => {
        attempt = 0;
        down = false;
        log.info({ msg: 'sync_stream_up', team: slug });
        // The hub only rings on growth; ask for whatever landed while we were not connected.
        kickSyncPull(ctx);
      });
      socket.on('message', (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return;
        }
        const frame = SyncStreamFrameSchema.safeParse(parsed);
        if (!frame.success) return;
        if (frame.data.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        } else if (frame.data.type === 'head') {
          const seq = frame.data.seq;
          void readPullCursor(ctx.db, teamId)
            .then((cursor) => {
              if (seq > cursor) kickSyncPull(ctx);
            })
            .catch(() => kickSyncPull(ctx));
        }
      });
      const lost = (reason: string) => {
        if (ws === socket) ws = null;
        if (closed || stopped) return;
        if (!down) {
          down = true;
          log.warn({ msg: 'sync_stream_down', team: slug, reason });
        }
        schedule();
      };
      socket.on('close', () => lost('closed'));
      // `ws` emits `error` then `close` for a failed connect; the close handler schedules the retry.
      socket.on('error', (error) => {
        if (!down) log.warn({ msg: 'sync_stream_error', team: slug, error: String(error) });
      });
    };

    connect();
    return {
      hubUrl,
      credential,
      stop() {
        closed = true;
        if (timer) clearTimeout(timer);
        ws?.terminate();
      },
    };
  };

  // Enrollment lives in node.json, keyed by slug; look for new, changed and removed ones.
  const scan = async () => {
    if (stopped) return;
    try {
      const nodes = readNodeState().nodes;
      const teams = await listActiveTeams(ctx.db);
      const wanted = new Set<string>();
      for (const team of teams) {
        const record = nodes[team.slug];
        // Same rule as pull.ts/push.ts: an enrollment is THIS daemon's only if it names this
        // daemon's node row (node.json is keyed by slug, and a copied file is not an identity).
        const local = await ctx.db.get<{ node_id: string }>(
          'SELECT node_id FROM local_node WHERE team_id = ?',
          [team.id],
        );
        if (!record || !local || record.node_id !== local.node_id) continue;
        wanted.add(team.slug);
        const have = links.get(team.slug);
        if (have && have.hubUrl === record.hub_url && have.credential === record.credential)
          continue;
        have?.stop();
        links.set(team.slug, open(team.slug, team.id, record.hub_url, record.credential));
      }
      for (const [slug, link] of links) {
        if (!wanted.has(slug)) {
          link.stop();
          links.delete(slug);
        }
      }
    } catch (error) {
      log.warn({ msg: 'sync_stream_scan_failed', error: String(error) });
    }
  };

  void scan();
  scanners.set(ctx.db, () => void scan());
  const handle = setInterval(() => void scan(), SYNC_STREAM_RESCAN_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => {
    stopped = true;
    scanners.delete(ctx.db);
    clearInterval(handle);
    for (const link of links.values()) link.stop();
    links.clear();
  };
}
