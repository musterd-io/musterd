/**
 * musterd away relay (ADR 659) — an always-on Cloudflare Worker with one Durable Object per team.
 *
 * The daemon is loopback-bound, so it dials OUT to its team's object over one hibernating
 * WebSocket. The relay carries two things and stores neither's content:
 *  - `deliver` frames: the relay makes the provider POST inside the request and drops the body;
 *    storage keeps metadata only (`ask_ref`, `dedupe_id`, `expires_at`, status, provider coords).
 *  - provider callbacks (`POST /callback/<slug>/<ask_ref>`): forwarded raw to the daemon, which
 *    parses and redeems them against its own state (ADR 623 §6). The relay verifies no provider
 *    signature and grants nothing: a callback here is a transport event, never an answer.
 *
 * Auth: the daemon presents its per-team credential as a Bearer on the socket upgrade; the Worker
 * stores only its sha256 (`TEAM_CREDENTIALS_JSON`, set by the operator). One live socket per
 * team — a second is refused 409, so a replaced socket is a credential event, not a reconnect.
 */

import {
  credentialHashFor,
  deliverVerdict,
  hashesEqual,
  parseDaemonFrame,
  providerRefFrom,
  reconcileRelayPending,
  RELAY_MAX_FRAME_BYTES,
  RELAY_PROVIDER_TIMEOUT_MS,
  type RelayPendingRow,
} from './relay.js';

export interface Env {
  AWAY_RELAY: DurableObjectNamespace;
  /** Secret (wrangler secret put): JSON map of team slug → sha256 hex of that team's credential. */
  TEAM_CREDENTIALS_JSON?: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function daemonAuthorized(request: Request, env: Env, slug: string): Promise<boolean> {
  const expected = credentialHashFor(env.TEAM_CREDENTIALS_JSON, slug);
  if (!expected) return false;
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  return hashesEqual(await sha256Hex(auth.slice('Bearer '.length)), expected);
}

// eslint-disable-next-line import/no-default-export -- the Workers runtime requires a default export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const connect = /^\/teams\/([^/]+)\/connect$/.exec(url.pathname);
    if (request.method === 'GET' && connect) {
      const slug = decodeURIComponent(connect[1]!);
      if (request.headers.get('upgrade') !== 'websocket')
        return new Response('websocket upgrade required', { status: 426 });
      if (!(await daemonAuthorized(request, env, slug)))
        return new Response('unauthorized', { status: 401 });
      return env.AWAY_RELAY.get(env.AWAY_RELAY.idFromName(slug)).fetch(request);
    }
    const callback = /^\/callback\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'POST' && callback) {
      const slug = decodeURIComponent(callback[1]!);
      return env.AWAY_RELAY.get(env.AWAY_RELAY.idFromName(slug)).fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** One team's relay object: its socket, its pending metadata, its expiry alarm. */
export class TeamRelay implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS pending (
           ask_ref TEXT PRIMARY KEY,
           dedupe_id TEXT NOT NULL UNIQUE,
           expires_at INTEGER NOT NULL,
           status TEXT NOT NULL,
           provider_ref TEXT,
           created_at INTEGER NOT NULL
         )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('upgrade') === 'websocket') {
      // One live daemon socket per team (ADR 659 §1); the second is refused, not substituted.
      if (this.state.getWebSockets().length > 0)
        return new Response('a daemon socket is already live for this team', { status: 409 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const callback = /^\/callback\/[^/]+\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'POST' && callback) {
      const body = await request.text();
      if (new TextEncoder().encode(body).length > RELAY_MAX_FRAME_BYTES)
        return new Response('callback too large', { status: 413 });
      const socket = this.state.getWebSockets()[0];
      if (!socket) return new Response('daemon not connected', { status: 503 });
      socket.send(
        JSON.stringify({
          protocol: 1,
          type: 'callback',
          ask_ref: decodeURIComponent(callback[1]!),
          ...(request.headers.get('content-type')
            ? { content_type: request.headers.get('content-type') }
            : {}),
          body,
        }),
      );
      return new Response('accepted', { status: 202 });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const frame = parseDaemonFrame(raw);
    if (!frame) {
      ws.send(JSON.stringify({ protocol: 1, type: 'error', reason: 'malformed frame' }));
      return;
    }
    const now = Date.now();
    if (frame.type === 'reconcile') {
      const rows = this.rows();
      const { kept, dropped } = reconcileRelayPending(rows, frame.pending, now);
      for (const askRef of dropped) this.deleteRow(askRef);
      // The daemon's set is authoritative for inserts too: a delivery the relay lost (eviction
      // between POST and store) is re-pushed by the daemon, so reconcile only ever deletes.
      ws.send(JSON.stringify({ protocol: 1, type: 'reconciled', kept, dropped }));
      await this.scheduleAlarm();
      return;
    }
    if (frame.type === 'resolve') {
      this.deleteRow(frame.ask_ref);
      await this.scheduleAlarm();
      return;
    }
    // deliver: store metadata first (no content), then make the provider POST inside the request.
    const existing = this.state.storage.sql
      .exec<{
        status: string;
        provider_ref: string | null;
      }>('SELECT status, provider_ref FROM pending WHERE dedupe_id = ?', frame.dedupe_id)
      .toArray()[0];
    const count = this.state.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM pending')
      .toArray()[0]!.n;
    const verdict = deliverVerdict(Boolean(existing), count, frame.expires_at, now);
    if (verdict === 'expired' || verdict === 'full') {
      ws.send(
        JSON.stringify({
          protocol: 1,
          type: 'error',
          reason: verdict === 'expired' ? 'ask already expired' : 'pending cap reached',
          ask_ref: frame.ask_ref,
        }),
      );
      return;
    }
    if (verdict === 'duplicate') {
      ws.send(
        JSON.stringify({
          protocol: 1,
          type: 'delivered',
          ask_ref: frame.ask_ref,
          dedupe_id: frame.dedupe_id,
          ok: existing!.status === 'delivered',
          ...(existing!.provider_ref ? { provider_ref: existing!.provider_ref } : {}),
        }),
      );
      return;
    }
    this.state.storage.sql.exec(
      `INSERT INTO pending (ask_ref, dedupe_id, expires_at, status, provider_ref, created_at)
       VALUES (?, ?, ?, 'pending', NULL, ?)
       ON CONFLICT(ask_ref) DO UPDATE SET dedupe_id = excluded.dedupe_id,
         expires_at = excluded.expires_at, status = 'pending'`,
      frame.ask_ref,
      frame.dedupe_id,
      frame.expires_at,
      now,
    );
    let ok = false;
    let status: number | undefined;
    let providerRef: string | undefined;
    try {
      const res = await fetch(frame.post.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(frame.post.headers ?? {}) },
        body: frame.post.body,
        signal: AbortSignal.timeout(RELAY_PROVIDER_TIMEOUT_MS),
      });
      ok = res.ok;
      status = res.status;
      providerRef = providerRefFrom(await res.text());
    } catch {
      ok = false;
    }
    this.state.storage.sql.exec(
      'UPDATE pending SET status = ?, provider_ref = ? WHERE ask_ref = ?',
      ok ? 'delivered' : 'failed',
      providerRef ?? null,
      frame.ask_ref,
    );
    ws.send(
      JSON.stringify({
        protocol: 1,
        type: 'delivered',
        ask_ref: frame.ask_ref,
        dedupe_id: frame.dedupe_id,
        ok,
        ...(status !== undefined ? { status } : {}),
        ...(providerRef ? { provider_ref: providerRef } : {}),
      }),
    );
    await this.scheduleAlarm();
  }

  async webSocketClose(): Promise<void> {
    // Rows persist across a dropped socket; the daemon's next reconcile decides what still lives.
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.state.storage.sql.exec('DELETE FROM pending WHERE expires_at <= ?', now);
    await this.scheduleAlarm();
  }

  private rows(): RelayPendingRow[] {
    return this.state.storage.sql
      .exec<RelayPendingRow>('SELECT ask_ref, dedupe_id, expires_at FROM pending')
      .toArray();
  }

  private deleteRow(askRef: string): void {
    this.state.storage.sql.exec('DELETE FROM pending WHERE ask_ref = ?', askRef);
  }

  /** One alarm per object, at the earliest pending expiry; none when nothing is pending. */
  private async scheduleAlarm(): Promise<void> {
    const next = this.state.storage.sql
      .exec<{ next: number | null }>('SELECT MIN(expires_at) AS next FROM pending')
      .toArray()[0]?.next;
    if (next) await this.state.storage.setAlarm(next);
    else await this.state.storage.deleteAlarm();
  }
}
