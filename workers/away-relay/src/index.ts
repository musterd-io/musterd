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
 * team — a second with the same credential is refused 409; one presenting the rotated-in
 * credential replaces the stale socket, and every frame re-checks the credential against the
 * operator map, so rotation or revocation refuses the old socket's next frame (§4).
 */

import {
  credentialHashFor,
  deliverVerdict,
  hashesEqual,
  parseDaemonFrame,
  providerRefFrom,
  reconcileRelayPending,
  secondSocketVerdict,
  socketCredentialLive,
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

/** The sha256 of the presented credential when it matches the operator map for this team, else null. */
async function presentedCredentialHash(
  request: Request,
  env: Env,
  slug: string,
): Promise<string | null> {
  const expected = credentialHashFor(env.TEAM_CREDENTIALS_JSON, slug);
  if (!expected) return null;
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const presented = await sha256Hex(auth.slice('Bearer '.length));
  return hashesEqual(presented, expected) ? presented : null;
}

/** What a live socket presented at upgrade, kept on the socket so frames can be re-checked (§4). */
interface SocketAttachment {
  slug: string;
  credentialHash: string | null;
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
      const credentialHash = await presentedCredentialHash(request, env, slug);
      if (!credentialHash) return new Response('unauthorized', { status: 401 });
      // Hand the object the hash that was just verified (never the credential itself): the object
      // attaches it to the socket and re-checks it against the operator map on every frame (§4).
      const inner = new Request(request);
      inner.headers.set('x-relay-credential-hash', credentialHash);
      return env.AWAY_RELAY.get(env.AWAY_RELAY.idFromName(slug)).fetch(inner);
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
      const slug = decodeURIComponent(/^\/teams\/([^/]+)\/connect$/.exec(url.pathname)?.[1] ?? '');
      const presented = request.headers.get('x-relay-credential-hash');
      // One live daemon socket per team (ADR 659 §1): a second socket with the same credential
      // is refused 409. The one exception is rotation (§4, amended 2026-10-19): a socket
      // presenting the operator map's current credential replaces a live socket still holding
      // the rotated-away one, instead of locking the daemon out until the stale socket dies.
      const live = this.state.getWebSockets();
      if (live.length > 0) {
        const attachment = live[0]!.deserializeAttachment() as SocketAttachment | null;
        const verdict = secondSocketVerdict(
          attachment?.credentialHash ?? null,
          presented,
          credentialHashFor(this.env.TEAM_CREDENTIALS_JSON, slug),
        );
        if (verdict === 'refuse')
          return new Response('a daemon socket is already live for this team', { status: 409 });
        for (const old of live) old.close(1008, 'credential rotated');
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ slug, credentialHash: presented } satisfies SocketAttachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const callback = /^\/callback\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'POST' && callback) {
      const body = await request.text();
      if (new TextEncoder().encode(body).length > RELAY_MAX_FRAME_BYTES)
        return new Response('callback too large', { status: 413 });
      const socket = this.state.getWebSockets()[0];
      if (!socket) return new Response('daemon not connected', { status: 503 });
      // The §4 re-check applies to what a socket RECEIVES, not only what it sends: a rotated or
      // revoked socket that stays silent must not keep receiving callbacks (their bodies carry
      // ask tokens). Refuse with 503 so the provider retries against the legitimate daemon.
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (
        !socketCredentialLive(
          attachment?.credentialHash ?? null,
          credentialHashFor(this.env.TEAM_CREDENTIALS_JSON, decodeURIComponent(callback[1]!)),
        )
      ) {
        socket.close(1008, 'credential rotated or revoked');
        return new Response('daemon credential rotated or revoked', { status: 503 });
      }
      socket.send(
        JSON.stringify({
          protocol: 1,
          type: 'callback',
          ask_ref: decodeURIComponent(callback[2]!),
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
    // ADR 659 §4: the credential is re-checked on every frame, not only at upgrade. Once the
    // operator map names a different hash (rotation) or none (revocation), this socket's next
    // frame is refused and the socket is closed; the daemon reconnects with the new credential.
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (
      !socketCredentialLive(
        attachment?.credentialHash ?? null,
        credentialHashFor(this.env.TEAM_CREDENTIALS_JSON, attachment?.slug ?? ''),
      )
    ) {
      ws.send(
        JSON.stringify({ protocol: 1, type: 'error', reason: 'credential rotated or revoked' }),
      );
      ws.close(1008, 'credential rotated or revoked');
      return;
    }
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
    const verdict = deliverVerdict(existing?.status ?? null, count, frame.expires_at, now);
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
