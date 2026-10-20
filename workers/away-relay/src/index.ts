/**
 * musterd away relay (ADR 659) — an always-on Cloudflare Worker with one Durable Object per team.
 *
 * The daemon is loopback-bound, so it dials OUT to its team's object over one hibernating
 * WebSocket. The relay carries two things and stores neither's content:
 *  - `deliver` frames: the relay makes the provider POST inside the request and drops the body;
 *    storage keeps metadata only (`ask_ref`, `dedupe_id`, `expires_at`, status, provider coords).
 *  - Slack callbacks (`POST /callback/<slug>/<ask_ref>`): signature-verified and install-mapped
 *    before forwarding raw to the daemon, which parses and redeems against its own state (ADR 623 §6).
 *    The relay grants nothing: a callback here is a transport event, never an answer.
 *  - The musterd app (ADR 676 §2, §9): `app_deliver` frames are pushed through APNs with ciphertext
 *    only, the body inline when it fits, else by ref; the phone's sealed callbacks arrive at
 *    `POST /app/<slug>/callback` and its body fetches at `GET /app/<slug>/body/<binding>/<ref>`,
 *    which the object answers by asking the daemon over the socket. No sealed body is stored, and
 *    app deliveries keep no pending row: each carries a fresh token, so each is a new delivery.
 *
 * Auth: the daemon presents its per-team credential as a Bearer on the socket upgrade; the Worker
 * stores only its sha256 (`TEAM_CREDENTIALS_JSON`, set by the operator). One live socket per
 * team — a second with the same credential is refused 409; one presenting the rotated-in
 * credential replaces the stale socket, and every frame re-checks the credential against the
 * operator map, so rotation or revocation refuses the old socket's next frame (§4).
 */

import { apnsConfigFrom, sendApns } from './apns.js';
import {
  cloudDestinationFrom,
  ingressSignedPayload,
  installStateLive,
  parseSlackOAuthResponse,
  slackAuthorizeUrl,
  type SlackInstallRecord,
} from './installs.js';
import {
  credentialHashFor,
  deliverVerdict,
  hashesEqual,
  parseDaemonFrame,
  providerRefFrom,
  quotaForTeam,
  quotaVerdict,
  reconcileRelayPending,
  secondSocketVerdict,
  slackDispatchAllowed,
  slackSignatureValid,
  slackTeamIdFromBody,
  socketCredentialLive,
  RELAY_MAX_FRAME_BYTES,
  RELAY_PROVIDER_TIMEOUT_MS,
  appCallbackRef,
  apnsPayload,
  type DaemonFrame,
  type RelayPendingRow,
  type SealedBody,
} from './relay.js';

export interface Env {
  AWAY_RELAY: DurableObjectNamespace;
  /** The Slack install registry (increment 9): install states and the Slack team → slug mapping. */
  SLACK_INSTALLS: DurableObjectNamespace;
  /** Secret (wrangler secret put): JSON map of team slug → sha256 hex of that team's credential. */
  TEAM_CREDENTIALS_JSON?: string;
  /** Secret (wrangler secret put): Slack's signing secret — lives only here (ADR 668 §1). */
  SLACK_SIGNING_SECRET?: string;
  /** Secret (wrangler secret put): JSON map of Slack team id → musterd team slug (ADR 668 §2). */
  SLACK_TEAM_MAP_JSON?: string;
  /** Optional (wrangler secret put): JSON map of team slug → {per_minute, per_day} delivery quota overrides. */
  TEAM_QUOTAS_JSON?: string;
  /** Secret (wrangler secret put): the APNs `.p8` token key, PEM (ADR 676 §9, ADR 659 §4). */
  APNS_KEY_P8?: string;
  /** The distributed Slack app's client id (wrangler.toml var) and client secret (secret). */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Secret: this ingress's Ed25519 signing key (PKCS8 PEM) for Cloud dispatches (spec §3). */
  INGRESS_SIGNING_KEY?: string;
  /** The APNs key id, the Apple Developer team id and the app's bundle id (wrangler.toml vars). */
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
}

/** How long the phone's body fetch waits for the daemon's answer over the socket. */
const APP_FETCH_TIMEOUT_MS = 5_000;

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

/**
 * Sign one Cloud dispatch (spec: Slack ingress §3). Returns the timestamp and the
 * base64url signature, or null when this ingress holds no signing key — a Cloud
 * dispatch without an attestation is never sent unsigned.
 */
async function ingressAttestation(
  env: Env,
  rawBody: string,
): Promise<{ timestamp: string; signature: string } | null> {
  if (!env.INGRESS_SIGNING_KEY) return null;
  try {
    const der = Uint8Array.from(
      atob(env.INGRESS_SIGNING_KEY.replace(/-----(BEGIN|END) [^-]+-----/g, '').replace(/\s+/g, '')),
      (c) => c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
    const timestamp = String(Date.now());
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      key,
      new TextEncoder().encode(ingressSignedPayload(timestamp, rawBody)),
    );
    const b64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    return { timestamp, signature: b64 };
  } catch {
    return null;
  }
}

/** POST one attested dispatch to a Cloud server; true only on a 2xx from that server. */
async function postToCloud(
  env: Env,
  destination: string,
  path: string,
  rawBody: string,
  contentType: string,
): Promise<boolean> {
  const attestation = await ingressAttestation(env, rawBody);
  if (!attestation) return false;
  try {
    const res = await fetch(`${destination}${path}`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-musterd-ingress-timestamp': attestation.timestamp,
        'x-musterd-ingress-signature': attestation.signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(RELAY_PROVIDER_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The install registry object: one instance holds the states and the mapping. */
function installRegistry(env: Env): DurableObjectStub {
  return env.SLACK_INSTALLS.get(env.SLACK_INSTALLS.idFromName('slack-installs'));
}

async function registryJson(
  env: Env,
  path: string,
  init?: { method: string; body: unknown },
): Promise<Record<string, unknown> | null> {
  try {
    const res = await installRegistry(env).fetch(
      new Request(`https://installs.internal${path}`, {
        ...(init
          ? {
              method: init.method,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(init.body),
            }
          : {}),
      }),
    );
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// eslint-disable-next-line import/no-default-export -- the Workers runtime requires a default export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The distributed Slack app's install flow (ADR 668 decision 2, increment 9). The link a
    // daemon mints names its team and a one-time state; Slack's installer authorizes there,
    // and Slack returns to /slack/oauth with a code this Worker exchanges. Only this flow
    // writes the install mapping — never anything an incoming callback carries.
    if (request.method === 'GET' && url.pathname === '/slack/install') {
      const slug = url.searchParams.get('team') ?? '';
      const installState = url.searchParams.get('state') ?? '';
      if (!slug || installState.length < 16)
        return new Response('install link is missing its team or state', { status: 400 });
      if (!env.SLACK_CLIENT_ID)
        return new Response('slack app not configured on this relay', { status: 503 });
      // The state must be one the named team's daemon minted: its relay object holds
      // the hash it registered over the authenticated socket. An unregistered state —
      // however plausible — starts no install, so a leaked link cannot be re-bound.
      const stateHash = await sha256Hex(installState);
      let registered = false;
      let registeredDestination: unknown = null;
      try {
        const checkRes = await env.AWAY_RELAY.get(env.AWAY_RELAY.idFromName(slug)).fetch(
          new Request(`https://relay.internal/install-state/${stateHash}`),
        );
        const check = checkRes.ok
          ? ((await checkRes.json()) as { registered?: boolean; destination?: unknown })
          : null;
        registered = check?.registered === true;
        registeredDestination = check?.destination ?? null;
      } catch {
        registered = false;
      }
      if (!registered)
        return new Response('install state not registered by that team', { status: 403 });
      const recorded = await registryJson(env, '/state', {
        method: 'PUT',
        body: {
          state: installState,
          slug,
          // The destination comes only from what the team's daemon registered at mint
          // over its authenticated socket (spec: Slack ingress §3) — never from this
          // link. A `dest` query parameter selects nothing; a laptop daemon registers
          // none and its record is held by its relay object.
          destination: cloudDestinationFrom(registeredDestination),
        },
      });
      if (!recorded) return new Response('install registry unavailable', { status: 503 });
      return Response.redirect(
        slackAuthorizeUrl({
          clientId: env.SLACK_CLIENT_ID,
          redirectUri: `${url.origin}/slack/oauth`,
          state: installState,
        }),
        302,
      );
    }
    if (request.method === 'GET' && url.pathname === '/slack/oauth') {
      const code = url.searchParams.get('code') ?? '';
      const installState = url.searchParams.get('state') ?? '';
      if (!code || !installState) return new Response('missing code or state', { status: 400 });
      if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET)
        return new Response('slack app not configured on this relay', { status: 503 });
      const looked = await registryJson(env, `/state/${encodeURIComponent(installState)}`);
      const slug = typeof looked?.['slug'] === 'string' ? (looked['slug'] as string) : null;
      if (!slug || looked?.['live'] !== true)
        return new Response('install state unknown or expired', { status: 403 });
      const destination = cloudDestinationFrom(looked?.['destination']);
      if (destination && !env.INGRESS_SIGNING_KEY)
        return new Response('cloud dispatch is not configured on this relay', { status: 503 });
      let record: SlackInstallRecord | null = null;
      try {
        const res = await fetch('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: env.SLACK_CLIENT_ID,
            client_secret: env.SLACK_CLIENT_SECRET,
            code,
            redirect_uri: `${url.origin}/slack/oauth`,
          }),
          signal: AbortSignal.timeout(RELAY_PROVIDER_TIMEOUT_MS),
        });
        record = parseSlackOAuthResponse((await res.json()) as unknown);
      } catch {
        record = null;
      }
      if (!record) return new Response('slack install exchange failed', { status: 502 });
      const mapped = await registryJson(env, '/install', {
        method: 'PUT',
        body: {
          state: installState,
          slack_team_id: record.slackTeamId,
          slug,
          installer: record.installerSlackId,
          destination,
        },
      });
      if (!mapped) return new Response('install registry unavailable', { status: 503 });
      if (destination) {
        // Cloud-direct (spec §3): the record goes straight to the hosted team's server,
        // attested by this ingress. That server stores it against the state it minted.
        const delivered = await postToCloud(
          env,
          destination,
          `/teams/${encodeURIComponent(slug)}/channels/slack/install-record`,
          JSON.stringify({
            slack_team_id: record.slackTeamId,
            bot_token: record.botToken,
            installer_slack_id: record.installerSlackId,
            state: installState,
            installed_at: Date.now(),
          }),
          'application/json',
        );
        if (!delivered)
          return new Response('could not deliver the install to its server', { status: 502 });
        return new Response(
          'Slack app installed for this workspace. Return to musterd — your hosted team has the install.',
          { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
        );
      }
      // Hold the per-install token in the team's own object until its daemon syncs it
      // (install_sync / install_ack); the registry keeps only the routing mapping.
      const held = await env.AWAY_RELAY.get(env.AWAY_RELAY.idFromName(slug)).fetch(
        new Request('https://relay.internal/install-record', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            slack_team_id: record.slackTeamId,
            bot_token: record.botToken,
            installer_slack_id: record.installerSlackId,
            state: installState,
            installed_at: Date.now(),
          }),
        }),
      );
      if (!held.ok)
        return new Response('could not hold the install for its daemon', { status: 503 });
      return new Response(
        'Slack app installed for this workspace. Return to musterd — the install completes when your daemon next connects.',
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
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
      const rawBody = await request.text();
      // This route currently serves Slack only. Detect Slack form callbacks by parsed field,
      // independent of form field order, and treat Slack signature headers as a Slack signal too.
      // Every accepted callback is verified and mapped before the daemon sees it.
      const slackShaped =
        new URLSearchParams(rawBody).has('payload') || request.headers.has('x-slack-signature');
      if (!slackShaped) return new Response('unsupported callback', { status: 400 });
      if (!env.SLACK_SIGNING_SECRET)
        return new Response('slack signing secret not configured', { status: 503 });
      const valid = await slackSignatureValid(
        env.SLACK_SIGNING_SECRET,
        request.headers.get('x-slack-request-timestamp') ?? '',
        rawBody,
        request.headers.get('x-slack-signature') ?? '',
        Date.now(),
      );
      if (!valid) return new Response('invalid slack signature', { status: 401 });
      // Dispatch is by the install record (increment 9): the OAuth registry first, the
      // operator-set map as the pre-install fallback. No request field selects a destination.
      const payloadTeam = slackTeamIdFromBody(rawBody);
      const registered = payloadTeam
        ? await registryJson(env, `/slug-for/${encodeURIComponent(payloadTeam)}`)
        : null;
      const registeredSlug =
        typeof registered?.['slug'] === 'string' ? (registered['slug'] as string) : null;
      if (registeredSlug !== null) {
        if (registeredSlug !== slug)
          return new Response('slack team not mapped to this destination', { status: 403 });
        // Cloud-direct (spec §3): a hosted team's callbacks go straight to its server,
        // raw body unmodified under this ingress's attestation — no relay hop, no socket.
        const cloudDest = cloudDestinationFrom(registered?.['destination']);
        if (cloudDest) {
          const delivered = await postToCloud(
            env,
            cloudDest,
            `/teams/${encodeURIComponent(slug)}/channels/slack/callback/${encodeURIComponent(decodeURIComponent(callback[2]!))}`,
            rawBody,
            request.headers.get('content-type') ?? 'application/x-www-form-urlencoded',
          );
          return delivered
            ? new Response(null, { status: 202 })
            : new Response('cloud destination did not accept the callback', { status: 502 });
        }
      } else if (!env.SLACK_TEAM_MAP_JSON) {
        return new Response('slack team map not configured', { status: 503 });
      } else if (!slackDispatchAllowed(payloadTeam, env.SLACK_TEAM_MAP_JSON, slug)) {
        return new Response('slack team not mapped to this destination', { status: 403 });
      }
      return env.AWAY_RELAY.get(env.AWAY_RELAY.idFromName(slug)).fetch(
        new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: rawBody,
        }),
      );
    }
    // The musterd app (ADR 676). No credential: the phone's trust is its seal and signature, which
    // only the daemon checks. The relay checks shape, forwards, and stores nothing.
    const appCallback = /^\/app\/([^/]+)\/callback$/.exec(url.pathname);
    if (request.method === 'POST' && appCallback) {
      const slug = decodeURIComponent(appCallback[1]!);
      const rawBody = await request.text();
      const ref = appCallbackRef(rawBody);
      if (!ref) return new Response('malformed app callback', { status: 400 });
      return env.AWAY_RELAY.get(env.AWAY_RELAY.idFromName(slug)).fetch(
        new Request(
          `${url.origin}/callback/${encodeURIComponent(slug)}/${encodeURIComponent(ref)}`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody },
        ),
      );
    }
    const appBody = /^\/app\/([^/]+)\/body\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && appBody) {
      const slug = decodeURIComponent(appBody[1]!);
      return env.AWAY_RELAY.get(env.AWAY_RELAY.idFromName(slug)).fetch(
        new Request(request.url, { method: 'GET' }),
      );
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * The Slack install registry (ADR 668 decision 2, increment 9): install states a daemon
 * minted, and the mapping the OAuth flow wrote — Slack team id → musterd team slug +
 * installer. Routing data only: the per-install bot token never lands here; it is held
 * by the team's own object until its daemon syncs it. Internal routes only — the Worker
 * calls them; nothing public reaches this object.
 */
export class SlackInstalls implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS states (
           state TEXT PRIMARY KEY, slug TEXT NOT NULL, created_at INTEGER NOT NULL, consumed_at INTEGER,
           destination TEXT
         )`,
      );
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS installs (
           slack_team_id TEXT PRIMARY KEY, slug TEXT NOT NULL, installer TEXT NOT NULL, installed_at INTEGER NOT NULL,
           destination TEXT
         )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (request.method === 'PUT' && url.pathname === '/state') {
      const body = (await request.json()) as {
        state?: unknown;
        slug?: unknown;
        destination?: unknown;
      };
      if (
        typeof body.state !== 'string' ||
        body.state.length < 16 ||
        typeof body.slug !== 'string' ||
        !body.slug
      )
        return json({ error: 'bad state' }, 400);
      // Insert-only: a state is bound once, to the team that registered it. A second
      // write naming a different team conflicts and changes nothing — in particular it
      // never resets consumption or the clock (ADR 668 decision 2).
      const existing = this.state.storage.sql
        .exec<{ slug: string }>('SELECT slug FROM states WHERE state = ?', body.state)
        .toArray()[0];
      if (existing && existing.slug !== body.slug)
        return json({ error: 'state bound to another team' }, 409);
      if (!existing)
        this.state.storage.sql.exec(
          `INSERT INTO states (state, slug, created_at, consumed_at, destination) VALUES (?, ?, ?, NULL, ?)`,
          body.state,
          body.slug,
          Date.now(),
          cloudDestinationFrom(body.destination),
        );
      return json({ ok: true });
    }
    const stateMatch = /^\/state\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && stateMatch) {
      const row = this.state.storage.sql
        .exec<{
          slug: string;
          created_at: number;
          consumed_at: number | null;
          destination: string | null;
        }>(
          'SELECT slug, created_at, consumed_at, destination FROM states WHERE state = ?',
          decodeURIComponent(stateMatch[1]!),
        )
        .toArray()[0];
      if (!row) return json({ slug: null, live: false });
      return json({
        slug: row.slug,
        destination: row.destination,
        live: installStateLive(row.created_at, row.consumed_at, Date.now()),
      });
    }
    if (request.method === 'PUT' && url.pathname === '/install') {
      const body = (await request.json()) as {
        state?: unknown;
        slack_team_id?: unknown;
        slug?: unknown;
        installer?: unknown;
        destination?: unknown;
      };
      if (
        typeof body.state !== 'string' ||
        typeof body.slack_team_id !== 'string' ||
        !body.slack_team_id ||
        typeof body.slug !== 'string' ||
        !body.slug ||
        typeof body.installer !== 'string' ||
        !body.installer
      )
        return json({ error: 'bad install' }, 400);
      // The state is consumed by the exchange that writes the mapping: one state, one install.
      const consumed = this.state.storage.sql.exec(
        'UPDATE states SET consumed_at = ? WHERE state = ? AND slug = ? AND consumed_at IS NULL',
        Date.now(),
        body.state,
        body.slug,
      );
      void consumed;
      this.state.storage.sql.exec(
        `INSERT INTO installs (slack_team_id, slug, installer, installed_at, destination) VALUES (?, ?, ?, ?)
         ON CONFLICT(slack_team_id) DO UPDATE SET slug = excluded.slug,
           installer = excluded.installer, installed_at = excluded.installed_at,
           destination = excluded.destination`,
        body.slack_team_id,
        body.slug,
        body.installer,
        Date.now(),
        cloudDestinationFrom(body.destination),
      );
      return json({ ok: true });
    }
    const slugMatch = /^\/slug-for\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && slugMatch) {
      const row = this.state.storage.sql
        .exec<{
          slug: string;
          destination: string | null;
        }>(
          'SELECT slug, destination FROM installs WHERE slack_team_id = ?',
          decodeURIComponent(slugMatch[1]!),
        )
        .toArray()[0];
      return json({ slug: row?.slug ?? null, destination: row?.destination ?? null });
    }
    return json({ error: 'not found' }, 404);
  }
}

/** One team's relay object: its socket, its pending metadata, its expiry alarm. */
export class TeamRelay implements DurableObject {
  /** Body fetches waiting on the daemon's `app_body`, by request id. In memory only: never stored. */
  private readonly fetches = new Map<
    string,
    (found: { sealed: SealedBody | null; expires_at?: number }) => void
  >();

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
      // Per-team delivery attempts for the quota windows (lane 01M50ZQCTWM5QBZ083782J9N6R):
      // timestamps only, no content, pruned past the day window on each delivery.
      this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (at INTEGER NOT NULL)`);
      // Slack install records held for this team's daemon (increment 9): the per-install
      // bot token lives here only until the daemon stores it and acks (install_ack).
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS slack_installs (
           slack_team_id TEXT PRIMARY KEY, bot_token TEXT NOT NULL,
           installer_slack_id TEXT NOT NULL, state TEXT NOT NULL, installed_at INTEGER NOT NULL
         )`,
      );
      // Install states this team's daemon minted (hashes only, ADR 668 decision 2): the
      // install flow accepts a state only when the named team's object holds its hash.
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS install_states (
           state_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, destination TEXT
         )`,
      );
      // Objects created before the destination column: add it; a duplicate-column
      // error just means it is already there.
      try {
        this.state.storage.sql.exec('ALTER TABLE install_states ADD COLUMN destination TEXT');
      } catch {
        // already migrated
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Internal: does this object hold a daemon-minted install state's hash?
    const stateCheck = /^\/install-state\/([0-9a-f]{64})$/.exec(url.pathname);
    if (request.method === 'GET' && stateCheck) {
      const row = this.state.storage.sql
        .exec<{
          created_at: number;
          destination: string | null;
        }>('SELECT created_at, destination FROM install_states WHERE state_hash = ?', stateCheck[1])
        .toArray()[0];
      const live = row !== undefined && installStateLive(row.created_at, null, Date.now());
      return new Response(
        JSON.stringify({ registered: live, destination: live ? (row?.destination ?? null) : null }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    // Internal: the Worker hands this object one install record after the OAuth exchange.
    if (request.method === 'PUT' && url.pathname === '/install-record') {
      const body = (await request.json()) as {
        slack_team_id?: unknown;
        bot_token?: unknown;
        installer_slack_id?: unknown;
        state?: unknown;
        installed_at?: unknown;
      };
      if (
        typeof body.slack_team_id !== 'string' ||
        !body.slack_team_id ||
        typeof body.bot_token !== 'string' ||
        !body.bot_token ||
        typeof body.installer_slack_id !== 'string' ||
        !body.installer_slack_id ||
        typeof body.state !== 'string' ||
        !body.state ||
        typeof body.installed_at !== 'number'
      )
        return new Response('bad install record', { status: 400 });
      this.state.storage.sql.exec(
        `INSERT INTO slack_installs (slack_team_id, bot_token, installer_slack_id, state, installed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slack_team_id) DO UPDATE SET bot_token = excluded.bot_token,
           installer_slack_id = excluded.installer_slack_id, state = excluded.state,
           installed_at = excluded.installed_at`,
        body.slack_team_id,
        body.bot_token,
        body.installer_slack_id,
        body.state,
        body.installed_at,
      );
      return new Response('held', { status: 200 });
    }
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
    const appBody = /^\/app\/([^/]+)\/body\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && appBody) {
      const slug = decodeURIComponent(appBody[1]!);
      const binding = decodeURIComponent(appBody[2]!);
      const askRef = decodeURIComponent(appBody[3]!);
      if (binding.length > 64 || askRef.length > 128)
        return new Response('not found', { status: 404 });
      const socket = this.liveSocket(slug);
      if (!socket) return new Response('daemon not connected', { status: 503 });
      const requestId = crypto.randomUUID();
      const found = await new Promise<{ sealed: SealedBody | null; expires_at?: number } | null>(
        (resolve) => {
          const timer = setTimeout(() => {
            this.fetches.delete(requestId);
            resolve(null);
          }, APP_FETCH_TIMEOUT_MS);
          this.fetches.set(requestId, (f) => {
            clearTimeout(timer);
            this.fetches.delete(requestId);
            resolve(f);
          });
          socket.send(
            JSON.stringify({
              protocol: 1,
              type: 'app_fetch',
              request_id: requestId,
              ask_ref: askRef,
              binding,
            }),
          );
        },
      );
      if (!found) return new Response('daemon did not answer', { status: 504 });
      if (!found.sealed) return new Response('not found', { status: 404 });
      return Response.json(
        {
          team: slug,
          binding,
          ref: askRef,
          expires_at: found.expires_at,
          sealed: found.sealed,
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    return new Response('not found', { status: 404 });
  }

  /**
   * The team's daemon socket, when one is live and its credential still current (§4). A socket
   * whose credential was rotated or revoked is closed here, so it never receives a phone's request.
   */
  private liveSocket(slug: string): WebSocket | null {
    const socket = this.state.getWebSockets()[0];
    if (!socket) return null;
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (
      !socketCredentialLive(
        attachment?.credentialHash ?? null,
        credentialHashFor(this.env.TEAM_CREDENTIALS_JSON, slug),
      )
    ) {
      socket.close(1008, 'credential rotated or revoked');
      return null;
    }
    return socket;
  }

  /** Push one sealed delivery to the app and tell the daemon how it went. Nothing is stored. */
  private async appDeliver(
    ws: WebSocket,
    slug: string,
    frame: Extract<DaemonFrame, { type: 'app_deliver' }>,
    now: number,
  ): Promise<void> {
    const reply = (fields: Record<string, unknown>) =>
      ws.send(
        JSON.stringify({
          protocol: 1,
          type: 'delivered',
          ask_ref: frame.ask_ref,
          dedupe_id: frame.dedupe_id,
          ...fields,
        }),
      );
    if (frame.expires_at <= now) {
      ws.send(
        JSON.stringify({
          protocol: 1,
          type: 'error',
          reason: 'ask already expired',
          ask_ref: frame.ask_ref,
        }),
      );
      return;
    }
    const config = apnsConfigFrom(this.env);
    if (!config) {
      ws.send(
        JSON.stringify({
          protocol: 1,
          type: 'error',
          reason: 'app push not configured on this relay',
          ask_ref: frame.ask_ref,
        }),
      );
      return;
    }
    const { body } = apnsPayload(slug, frame);
    const result = await sendApns(
      config,
      frame.push,
      { body, expiresAt: frame.expires_at, collapseId: frame.ask_ref },
      now,
    );
    reply({
      ok: result.ok,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.apnsId ? { provider_ref: result.apnsId } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    });
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
    if (frame.type === 'install_state') {
      this.state.storage.sql.exec(
        `INSERT INTO install_states (state_hash, created_at, destination) VALUES (?, ?, ?)
         ON CONFLICT(state_hash) DO NOTHING`,
        frame.state_hash,
        now,
        cloudDestinationFrom(frame.destination),
      );
      return;
    }
    if (frame.type === 'install_sync') {
      const installs = this.state.storage.sql
        .exec<{
          slack_team_id: string;
          bot_token: string;
          installer_slack_id: string;
          state: string;
          installed_at: number;
        }>(
          'SELECT slack_team_id, bot_token, installer_slack_id, state, installed_at FROM slack_installs',
        )
        .toArray();
      ws.send(JSON.stringify({ protocol: 1, type: 'installs', installs }));
      return;
    }
    if (frame.type === 'install_ack') {
      for (const id of frame.slack_team_ids)
        this.state.storage.sql.exec('DELETE FROM slack_installs WHERE slack_team_id = ?', id);
      return;
    }
    if (frame.type === 'app_deliver') {
      await this.appDeliver(ws, attachment?.slug ?? '', frame, now);
      return;
    }
    if (frame.type === 'app_body') {
      this.fetches.get(frame.request_id)?.({
        sealed: frame.sealed,
        ...(frame.expires_at !== undefined ? { expires_at: frame.expires_at } : {}),
      });
      return;
    }
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
    // Per-team quota (lane 01M50ZQCTWM5QBZ083782J9N6R): this object serves one team,
    // so its delivery counters are that team's alone. A refused delivery is stored
    // `failed`, exactly like a failed provider POST, so the daemon's re-push retries it.
    const quota = quotaForTeam(this.env.TEAM_QUOTAS_JSON, attachment?.slug ?? '');
    this.state.storage.sql.exec('DELETE FROM deliveries WHERE at <= ?', now - 86_400_000);
    const minuteAttempts =
      this.state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE at > ?', now - 60_000)
        .toArray()[0]?.n ?? 0;
    const dayAttempts =
      this.state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries')
        .toArray()[0]?.n ?? 0;
    const quotaResult = quotaVerdict(minuteAttempts, dayAttempts, quota);
    if (quotaResult !== 'ok') {
      this.state.storage.sql.exec(
        `INSERT INTO pending (ask_ref, dedupe_id, expires_at, status, provider_ref, created_at)
         VALUES (?, ?, ?, 'failed', NULL, ?)
         ON CONFLICT(ask_ref) DO UPDATE SET dedupe_id = excluded.dedupe_id,
           expires_at = excluded.expires_at, status = 'failed'`,
        frame.ask_ref,
        frame.dedupe_id,
        frame.expires_at,
        now,
      );
      ws.send(
        JSON.stringify({
          protocol: 1,
          type: 'delivered',
          ask_ref: frame.ask_ref,
          dedupe_id: frame.dedupe_id,
          ok: false,
          reason: quotaResult,
        }),
      );
      await this.scheduleAlarm();
      return;
    }
    this.state.storage.sql.exec('INSERT INTO deliveries (at) VALUES (?)', now);
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
      .exec<{
        ask_ref: string;
        dedupe_id: string;
        expires_at: number;
      }>('SELECT ask_ref, dedupe_id, expires_at FROM pending')
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
