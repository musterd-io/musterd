// Browser live client for the musterd team firehose (ADR 061).
//
// A port of the CLI's `watch()` (packages/cli/src/client.ts) to the browser `WebSocket`, with two
// differences that make it a *dashboard* client rather than an inbox watcher:
//   1. it subscribes with scope `team-all` (the firehose) so it receives EVERY envelope on the team,
//      not just messages addressed to this seat;
//   2. it backfills history over HTTP first (`GET /teams/:slug/messages`) so the view isn't empty,
//      then live-tails — the canonical "GET history, then subscribe, dedupe by id" pattern.
import type {
  AuditEntry,
  DoorbellPrefs,
  Envelope,
  Hold,
  HoldEffect,
  LaneBoard,
  LaneState,
  LaneResult,
  MemberSummary,
  OpenLane,
  Report,
  Request,
  SeatPulseFrame,
  UpdateLane,
  WorkingHours,
} from '@musterd/protocol';
import type {
  DoorbellSink,
  LaneChainLink,
  StyleDialsWire,
  StyleFloorWire,
  StylePrefsWire,
} from '@musterd/protocol/wire';
// The read path takes the validator-free door (ADR 148; `protocol/guards.ts`): the browser reads
// this daemon over its own origin and the daemon parses everything on ingest, so re-deriving the
// schemas here bought a strict page-level reject and ~20 KB of zod. The guards keep the one check
// that has a consumer — the per-row roster tolerance `unreadable` reports.
import {
  buildEnvelope,
  readAuditResponse,
  readLaneBoard,
  readLaneChain,
  readLaneResult,
  readMemberSummary,
  readReport,
  readWorkingHours,
  PROTOCOL_VERSION,
} from '@musterd/protocol/wire';

// Re-export so the audit view + route keep importing the entry type from this client module.
export type { AuditEntry };

export interface LiveConfig {
  team: string;
  /** The seat we authenticate as (an observer seat). */
  as: string;
  /**
   * The credential (mscr_) — the single v0.3 auth secret. It's the HTTP Bearer for the roster/history/
   * audit reads AND the `key` the WS `claim` handshake authenticates with (ADR 077). The legacy per-seat
   * token is no longer accepted by the daemon.
   */
  token: string;
}

export type ConnStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed';

/** Terminal auth failures — don't reconnect into them (a `superseded` reconnect war is the worst case). */
const TERMINAL_CODES = new Set(['unauthorized', 'forbidden', 'superseded', 'version_mismatch']);

/**
 * The dashboard talks to the daemon **same-origin** — no `server` URL. In dev a Vite proxy forwards
 * `/teams` + `/ws` to the daemon (and strips the browser Origin so the ADR 040 gate sees a clean
 * loopback client); in prod the daemon serves the web and these paths from one origin. This sidesteps
 * CORS and the WS Origin gate entirely.
 */
export function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export async function apiGet<T>(cfg: LiveConfig, path: string): Promise<T> {
  const res = await fetch(path, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      // Label our ambient presence as the web surface (ADR 057); never touch-suppress — we want the
      // dashboard to read present.
      'x-musterd-surface': 'web',
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // Carry the daemon's status + code so callers can distinguish a stale-observer 401 (self-heal) from
    // a real failure — a plain Error would erase the signal the route needs to auto-reprovision.
    const err = (json as { error?: { code?: string; message?: string } })?.error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return json as T;
}

/** Full team roster with presence/activity (`GET /teams/:slug`). */
export interface TeamRoster {
  members: MemberSummary[];
  working_hours: WorkingHours | null;
  /**
   * How many roster rows this bundle could not read — a seat whose `kind`/`surface`/`offline_reason`
   * carries a value that landed in the daemon after this client was built. Zero on a matched build.
   * Surfaced as a calm hint, never an error: see the forward-tolerance note on {@link fetchRoster}.
   */
  unreadable: number;
}

/**
 * Read the roster, tolerating rows from the daemon's future.
 *
 * This used to be `MemberSummarySchema.array().parse(...)`, and that one call made every enum in the
 * member shape a page-level single point of failure: the closed sets are strict, so ONE row with
 * a value the bundle predates threw the whole array, `useLiveStream` caught it into `setError`, and
 * /live rendered an error banner instead of a room. ADR 232's `kind: 'service'` fired it for real.
 *
 * That inverts ADR 148, whose whole premise is that a client behind the daemon degrades *calmly* — it
 * reads a quiet "behind" hint and keeps working. A page that cannot render is where the hint would have
 * gone, so the surface built to explain the skew was the surface the skew destroyed.
 *
 * So: parse each member independently, keep what we understand, and count what we do not so the roster
 * can say something small and true about the gap. **Read path only.** The write path stays strict —
 * accepting an unknown value on ingest is how bad data becomes durable. A response that isn't a roster
 * at all still throws: the tolerance is per-row, not blanket.
 */
export async function fetchRoster(cfg: LiveConfig): Promise<TeamRoster> {
  const raw = await apiGet<unknown>(cfg, `/teams/${encodeURIComponent(cfg.team)}`);
  if (!raw || typeof raw !== 'object') throw new Error('invalid team roster response');
  const response = raw as { members?: unknown; team?: unknown };
  if (!Array.isArray(response.members)) throw new Error('invalid team roster response: members');
  const members: MemberSummary[] = [];
  let unreadable = 0;
  for (const row of response.members) {
    const parsed = readMemberSummary(row);
    if (parsed) members.push(parsed);
    else unreadable += 1;
  }
  const team =
    response.team && typeof response.team === 'object'
      ? (response.team as { working_hours?: unknown })
      : undefined;
  return { members, working_hours: readWorkingHours(team?.working_hours), unreadable };
}

/** Whole-team history for backfill (`GET /teams/:slug/messages`, the firehose's history side). */
export async function fetchHistory(
  cfg: LiveConfig,
  opts: { since?: number; limit?: number } = {},
): Promise<Envelope[]> {
  const q = new URLSearchParams();
  if (opts.since != null) q.set('since', String(opts.since));
  if (opts.limit != null) q.set('limit', String(opts.limit));
  const qs = q.toString();
  const r = await apiGet<{ messages: Envelope[] }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/messages${qs ? `?${qs}` : ''}`,
  );
  return r.messages;
}

/** A fetch error that carries the daemon's HTTP status + error code, so a caller can tell a stale-observer
 * 401 from a real failure (and self-heal) and the view can tailor copy (401 vs 403). */
export class LiveFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LiveFetchError';
  }
}

/** The admin audit/requests reads throw this subclass so their `instanceof AuditFetchError` checks keep
 * working; it IS a {@link LiveFetchError} (carries `code` + `status`). */
export class AuditFetchError extends LiveFetchError {
  constructor(message: string, code: string, status: number) {
    super(message, code, status);
    this.name = 'AuditFetchError';
  }
}

/** True for the 401 the daemon returns when an observer credential is stale/invalid — a wiped DB or an
 * expired 24h observer TTL (ADR 064) leaves the cached `mscr_` unrecognised (`unauthorized`). Recoverable
 * by dropping it and provisioning a fresh observer, so `/live` self-heals instead of dead-ending. */
export function isStaleCredential(e: unknown): boolean {
  return e instanceof LiveFetchError && e.status === 401;
}

/**
 * The **admin-only** governance audit log (`GET /teams/:slug/audit`, ADR 071). Newest-first; pages
 * older via `before` (ms-epoch). Requires a seat with `is_admin`/`visibility_level: admin` — a 401
 * (no token) or 403 (non-admin) surfaces as an {@link AuditFetchError} so the route can explain it.
 */
export async function fetchAudit(
  cfg: LiveConfig,
  opts: { limit?: number; before?: number } = {},
): Promise<AuditEntry[]> {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set('limit', String(opts.limit));
  if (opts.before != null) q.set('before', String(opts.before));
  const qs = q.toString();
  const res = await fetch(
    `/teams/${encodeURIComponent(cfg.team)}/audit${qs ? `?${qs}` : ''}`,
    { headers: { authorization: `Bearer ${cfg.token}`, 'x-musterd-surface': 'web' } },
  );
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new AuditFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  // Validate the wire against the shared schema at the boundary (same contract the CLI parses, ADR 074).
  return readAuditResponse(json).audit;
}

/** Re-export for routes that import the Request type from this client module. */
export type { Request };

/**
 * The lane board (`GET /teams/:slug/lanes`, ADR 083) — the full set of lanes with live warnings
 * (ADR 084). Member-authed (any seat, not admin), so the read-only observer credential the dashboard
 * already holds is sufficient. Validates the wire against the shared schema at the boundary, and throws
 * a {@link LiveFetchError} on failure so a stale-observer 401 can self-heal (`isStaleCredential`).
 */
export async function fetchLaneBoard(
  cfg: LiveConfig,
  opts: {
    project?: string;
    open?: boolean;
    goal?: string;
    /** `brief=1`: rows without `detail` or `scope` (live-loads-fast inc 1, lane 01M4RNCZVB). */
    brief?: boolean;
    /** The repeatable `?state=` filter; omitted = every state inside the history window. */
    states?: readonly LaneState[];
  } = {},
): Promise<LaneBoard> {
  const q = new URLSearchParams();
  if (opts.project) q.set('project', opts.project);
  if (opts.open) q.set('open', '1');
  if (opts.goal) q.set('goal', opts.goal);
  if (opts.brief) q.set('brief', '1');
  for (const s of opts.states ?? []) q.append('state', s);
  const qs = q.toString();
  const json = await apiGet<unknown>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/lanes${qs ? `?${qs}` : ''}`,
  );
  return readLaneBoard(json);
}

/**
 * One lane's chain (ADR 629). `GET /lanes/:id` carries the history the board rows do not.
 * A bad envelope throws; the card then says the chain is unavailable rather than guessing.
 */
export async function fetchLaneChain(cfg: LiveConfig, id: string): Promise<LaneChainLink[]> {
  const json = await apiGet<unknown>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/lanes/${encodeURIComponent(id)}`,
  );
  return readLaneChain(json);
}

/**
 * What /live asks the board for (live-loads-fast inc 1, lane 01M4RNCZVB): brief rows, since the page
 * never shows a lane's `detail`, and every state but `abandoned`, which no surface on /live draws.
 * For a minute after a merge the daemon can be a build behind this bundle (the publisher and the
 * autorefresher run apart), so a 400 on `brief` falls back to the full read, never to an empty board.
 */
export const LIVE_BOARD_STATES: readonly LaneState[] = [
  'open',
  'claimed',
  'active',
  'blocked',
  'awaiting_acceptance',
  'ready_for_review',
  'parked',
  'done',
];
export async function fetchLiveLaneBoard(cfg: LiveConfig): Promise<LaneBoard> {
  try {
    return await fetchLaneBoard(cfg, { brief: true, states: LIVE_BOARD_STATES });
  } catch (e) {
    if (e instanceof LiveFetchError && e.status === 400) return fetchLaneBoard(cfg);
    throw e;
  }
}

/**
 * Send an act from the browser as the connected seat (ADR 149 — the /live asks strip's answer path).
 * An ordinary envelope through the member-authed `POST /messages`, so a browser answer is
 * indistinguishable from a CLI one to the daemon (same validation, same ask lifecycle audit). Only
 * meaningful for a **real** seat (the auto-provisioned observer is read-only by construction, ADR 063
 * — the daemon rejects its sends); callers gate the affordance on roster membership. Returns the
 * daemon's ack envelope so the view can fold the answer into its local timeline immediately; the
 * firehose copy of this HTTP send arrives a moment later and is deduped by id.
 */
/** What the daemon reports back about an acceptance verdict (ADR 202 + lane 01M5DTPMXN). */
export interface VerdictReport {
  lane_verdict?: { lane: string; state: 'done' | 'active' };
  lane_escalation?: { lane: string };
  lane_authority_refused?: { lane: string; reason: string };
}

type SendActInput = {
  act: Envelope['act'];
  to: Envelope['to'];
  body?: string;
  thread?: string | null;
  meta?: Record<string, unknown> | null;
};

async function postAct(
  cfg: LiveConfig,
  input: SendActInput,
): Promise<{ ack: Envelope } & VerdictReport> {
  const envelope = buildEnvelope({
    id: crypto.randomUUID(),
    team: cfg.team,
    from: cfg.as,
    to: input.to,
    body: input.body ?? '',
    act: input.act,
    thread: input.thread ?? null,
    meta: input.meta ?? null,
  });
  const res = await fetch(`/teams/${encodeURIComponent(cfg.team)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'application/json',
      'x-musterd-surface': 'web',
    },
    body: JSON.stringify({ envelope }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  const { ack, lane_verdict, lane_escalation, lane_authority_refused } = json as {
    ack: Envelope;
  } & VerdictReport;
  return {
    ack,
    ...(lane_verdict ? { lane_verdict } : {}),
    ...(lane_escalation ? { lane_escalation } : {}),
    ...(lane_authority_refused ? { lane_authority_refused } : {}),
  };
}

export async function sendAct(cfg: LiveConfig, input: SendActInput): Promise<Envelope> {
  return (await postAct(cfg, input)).ack;
}

/** Like {@link sendAct}, but also returns the daemon's verdict report beside the ack. */
export async function sendActWithVerdict(
  cfg: LiveConfig,
  input: SendActInput,
): Promise<{ ack: Envelope } & VerdictReport> {
  return postAct(cfg, input);
}

const b64urlToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bytesToB64url = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function apiPost<T>(cfg: LiveConfig, path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.token}`,
      'x-musterd-surface': 'web',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } })?.error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return json as T;
}

/**
 * The A2 proof a human's verdict on a lane needs (ADR 662, lane 01M5DTPMXN): the server
 * builds the descriptor, this browser signs it with the human's passkey, and the proof
 * rides back as `meta.approval`. Returns null when this human has no passkey enrolled —
 * the gate passes unenrolled humans unsigned, so the caller sends plain. Throws when the
 * ceremony is cancelled or fails: the caller must send nothing, because an unsigned
 * verdict from an enrolled human is refused — and used to vanish silently. A human
 * whose only enrolled key is not a passkey gets that refusal surfaced on the ack
 * instead; the CLI helper can sign with such a key.
 */
export async function authorityProofForVerdict(
  cfg: LiveConfig,
  lane: string,
  verdict: 'accept' | 'decline',
): Promise<Record<string, string> | null> {
  const teamPath = `/teams/${encodeURIComponent(cfg.team)}/authority`;
  const created = await apiPost<{ descriptor: { nonce: string } }>(cfg, `${teamPath}/descriptors`, {
    act: 'human_accept',
    target: lane,
    payload: { lane, verdict },
  });
  const nonce = created.descriptor.nonce;
  const view = await apiGet<{ passkeys?: { key_id: string; credential_id: string }[] }>(
    cfg,
    `${teamPath}/descriptors/${encodeURIComponent(nonce)}`,
  );
  if (!view.passkeys || view.passkeys.length === 0) return null;
  if (!navigator.credentials?.get) throw new Error('this browser cannot use a passkey');
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(nonce) as BufferSource,
      allowCredentials: view.passkeys.map((p) => ({
        type: 'public-key' as const,
        id: b64urlToBytes(p.credential_id) as BufferSource,
      })),
      userVerification: 'preferred',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('passkey cancelled — the verdict was not sent');
  const resp = assertion.response as AuthenticatorAssertionResponse;
  const key = view.passkeys.find(
    (p) => bytesToB64url(assertion.rawId) === p.credential_id.replace(/=+$/, ''),
  );
  if (!key) throw new Error('that passkey is not the enrolled one — the verdict was not sent');
  return {
    key_id: key.key_id,
    nonce,
    signature: bytesToB64url(resp.signature),
    authenticator_data: bytesToB64url(resp.authenticatorData),
    client_data_json: bytesToB64url(resp.clientDataJSON),
  };
}

/**
 * The writable board's mutation seam (item 5 / ADR 104): member-authed lane writes from the browser,
 * so a signed-in human creates/claims/moves work exactly like a CLI seat would. The daemon emits the
 * `lane_open`/`lane_claim`/`lane_state`/`lane_handoff`/`lane_resolve` team acts itself on these
 * verbs — the client must never send a companion act. Both return the daemon's echo (`{lane,
 * warnings}`) so the board can fold the change in optimistically, ahead of the firehose's lane act
 * (the AsksStrip precedent).
 */
async function laneMutation(
  cfg: LiveConfig,
  path: string,
  method: 'POST' | 'PATCH',
  input: unknown,
): Promise<LaneResult> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'application/json',
      'x-musterd-surface': 'web',
    },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  // Validate the wire at the boundary (same contract the CLI parses), like fetchLaneBoard.
  return readLaneResult(json);
}

/**
 * The insight report (`GET /teams/:slug/report`, ADR 050/084) — the one server-side projection the
 * board's rail renders (flow, waiting-on, blocked, coordination, MAST, steering). Member-authed, so
 * the read-only observer credential is sufficient; validated at the boundary like fetchLaneBoard.
 */
export async function fetchReport(cfg: LiveConfig): Promise<Report> {
  const json = await apiGet<unknown>(cfg, `/teams/${encodeURIComponent(cfg.team)}/report`);
  return readReport(json);
}

/** Open a lane as the signed-in member (`POST /teams/:slug/lanes`); `claim: true` self-owns it. */
export function createLane(cfg: LiveConfig, input: OpenLane): Promise<LaneResult> {
  return laneMutation(cfg, `/teams/${encodeURIComponent(cfg.team)}/lanes`, 'POST', input);
}

/** Update a lane — claim / advance / hand off / resolve are all this one PATCH seam. */
export function updateLane(cfg: LiveConfig, id: string, input: UpdateLane): Promise<LaneResult> {
  return laneMutation(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/lanes/${encodeURIComponent(id)}`,
    'PATCH',
    input,
  );
}

/* ─── shared read-only observer seat ──────────────────────────────────────────────────────────────
 * A hidden read-only seat (ADR 063/077) the browser caches per team, so any read-only surface —
 * /live, /board — can watch without connecting as a person. Minting one takes a human admin's
 * credential (ADR 580); a cached one keeps working until the observer TTL reaps it. Keyed the same across
 * surfaces so they reuse ONE observer per team rather than minting a seat each. `.v2` = credential-based
 * (ADR 077 claim handshake); bumping it drops legacy token creds. */
export interface ObserverCreds {
  name: string;
  /** The observer seat's credential (mscr_) — the single v0.3 auth secret (HTTP + WS claim). */
  token: string;
}
const observerKey = (team: string) => `musterd.live.observer.v2.${team}`;

export function loadObserver(team: string): ObserverCreds | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(observerKey(team));
    if (!raw) return null;
    const creds = JSON.parse(raw) as ObserverCreds;
    return creds && creds.token ? creds : null;
  } catch {
    return null;
  }
}
export function saveObserver(team: string, creds: ObserverCreds) {
  window.localStorage.setItem(observerKey(team), JSON.stringify(creds));
}
/**
 * Redeem a sign-in nonce (ADR 170) — the browser end of `musterd board`. The nonce arrives in the
 * URL fragment (never sent to a server by the browser, so it cannot land in an access log) and is
 * spent here for the member identity it stands for. Single-use and short-lived by construction, so
 * a failure is ordinary rather than exceptional: an expired or already-opened link 404s, and the
 * caller falls back to the normal connect form.
 */
export async function redeemSignin(
  team: string,
  nonce: string,
): Promise<{ as: string; credential: string }> {
  const res = await fetch(
    `/teams/${encodeURIComponent(team)}/signin-handoff/${encodeURIComponent(nonce)}`,
  );
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return json as { as: string; credential: string };
}

export function forgetObserver(team: string) {
  window.localStorage.removeItem(observerKey(team));
}
export function genObserverName(): string {
  return 'web-' + Math.random().toString(36).slice(2, 8);
}

/**
 * Since ADR 580 the daemon mints an observer only for a human admin's credential: loopback is no
 * longer enough, because an observer reads team traffic. A page holding no such credential cannot
 * get one, so it asks for a sign-in instead of sending a request it knows will be refused.
 */
export class ObserverSignInRequired extends Error {
  constructor() {
    super('watching needs a signed-in human — this page holds no seat to watch with');
    this.name = 'ObserverSignInRequired';
  }
}

/** Load this browser's cached observer for the team, or mint a fresh one with `bearer` and cache it.
 * Returns the {@link LiveConfig} a read-only surface connects with. This is the operator's OWN
 * dashboard seat — full-grade, so the office/stream still show the directed coordination that is
 * most of what there is to watch (ADR 136). `bearer` is a signed-in human admin's credential (ADR
 * 580); with none and nothing cached it throws {@link ObserverSignInRequired} without a request. */
export async function acquireObserver(team: string, bearer?: string | null): Promise<LiveConfig> {
  let creds = loadObserver(team);
  if (!creds) {
    if (!bearer) throw new ObserverSignInRequired();
    const name = genObserverName();
    const token = await provisionObserver(team, name, 'full', bearer);
    creds = { name, token };
    saveObserver(team, creds);
  }
  return { team, as: creds.name, token: creds.token };
}

/** The seat a capturer handed this page (ADR 594). Since ADR 580 a page cannot mint an observer over
 * loopback, so `musterd broadcast` mints one public-grade observer with its operator's human-admin
 * credential and injects it before the page loads — never in the URL or Chrome's argv, where `ps`
 * and logs would show it. Null when nothing was handed over, or it was handed for another team. */
export function handedObserver(team: string): LiveConfig | null {
  if (typeof window === 'undefined') return null;
  const seat = (window as unknown as { __musterdBroadcastSeat?: unknown }).__musterdBroadcastSeat;
  if (!seat || typeof seat !== 'object') return null;
  const { team: t, name, token } = seat as Record<string, unknown>;
  if (t !== team || typeof name !== 'string' || typeof token !== 'string' || !name || !token) {
    return null;
  }
  return { team, as: name, token };
}

/** /broadcast has no seat of its own to watch with: its capturer did not hand one over. */
export class BroadcastSeatMissing extends Error {
  constructor() {
    super(
      'no seat for this stream — /broadcast runs on the seat `musterd broadcast` or `musterd stream start` hands it',
    );
    this.name = 'BroadcastSeatMissing';
  }
}

/** The only seat /broadcast watches with: the one its capturer handed over (ADR 594), which is
 * broadcast-grade (ADR 601). Never this browser's cached observer — that one is full-grade, every DM
 * unmasked — and never a fresh mint. Throws {@link BroadcastSeatMissing} without a request. */
export function broadcastSeat(team: string): LiveConfig {
  const seat = handedObserver(team);
  if (!seat) throw new BroadcastSeatMissing();
  return seat;
}

/* ─── the shared watch-link seats (ADR 136, ADR 616) ──────────────────────────────────────────────
 * A watch link used to carry `acquireObserver`'s credential — the operator's own **full-grade** seat —
 * so handing someone a link handed them every DM on the team. A link now gets its own observer, never
 * `full`: **public** (team/broadcast traffic only, the default) or **broadcast** (ADR 616: everything
 * but a DM between two humans, keys masked — what a demo room is shown). One seat per grade, cached
 * per team so the link is stable (repeated copies hand out the same URL rather than littering seats;
 * idle ones are reaped at the 24h observer TTL, ADR 064). Separate seats mean a public link never
 * carries the broadcast seat's credential. The public key keeps its pre-616 name so links already
 * shared keep working. */
export type WatchGrade = 'public' | 'broadcast';
const watchLinkKey = (team: string, grade: WatchGrade) =>
  grade === 'public'
    ? `musterd.live.watchlink.v1.${team}`
    : `musterd.live.watchlink.${grade}.v1.${team}`;

/** The team's shared watch-link seat for `grade` — cached, or minted on first share.
 *
 * Minting requires a human admin's credential (ADR 580), so `bearer` is the signed-in member's. With
 * none and nothing cached it throws {@link ObserverSignInRequired} without a request. */
export async function acquireWatchLinkObserver(
  team: string,
  bearer: string | null,
  grade: WatchGrade = 'public',
): Promise<ObserverCreds> {
  try {
    const raw = window.localStorage.getItem(watchLinkKey(team, grade));
    if (raw) {
      const creds = JSON.parse(raw) as ObserverCreds;
      if (creds && creds.token) return creds;
    }
  } catch {
    // fall through and mint
  }
  if (!bearer) throw new ObserverSignInRequired();
  const name = (grade === 'public' ? 'watch-' : 'demo-') + Math.random().toString(36).slice(2, 8);
  const token = await provisionObserver(team, name, grade, bearer);
  const creds = { name, token };
  window.localStorage.setItem(watchLinkKey(team, grade), JSON.stringify(creds));
  return creds;
}

/** Drop the cached watch-link seat for `grade` — its link stops working on the next mint (the old
 *  seat lingers until the observer TTL reaps it). The other grade's seat is untouched. */
export function forgetWatchLinkObserver(team: string, grade: WatchGrade = 'public') {
  window.localStorage.removeItem(watchLinkKey(team, grade));
}

/**
 * List pending (or all) claim requests for the team — admin-only (ADR 077).
 * Uses AuditFetchError so the route can tailor 401/403 copy.
 */
export async function fetchRequests(
  cfg: LiveConfig,
  opts: { pendingOnly?: boolean } = {},
): Promise<Request[]> {
  const q = new URLSearchParams();
  if (opts.pendingOnly) q.set('status', 'pending');
  const qs = q.toString();
  const res = await fetch(
    `/teams/${encodeURIComponent(cfg.team)}/requests${qs ? `?${qs}` : ''}`,
    { headers: { authorization: `Bearer ${cfg.token}`, 'x-musterd-surface': 'web' } },
  );
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new AuditFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return (json as { requests: Request[] }).requests;
}

/** ADR 501: one authenticated POST from the web surface; the daemon's refusal travels as a LiveFetchError. */
function postAsWeb<T>(cfg: LiveConfig, path: string, body?: unknown): Promise<T> {
  return sendAsWeb(cfg, 'POST', path, body);
}

/** One authenticated write from the web surface, any method; the refusal travels as a LiveFetchError. */
async function sendAsWeb<T>(
  cfg: LiveConfig,
  method: 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'application/json',
      'x-musterd-surface': 'web',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return json as T;
}

/**
 * ADR 501: halt an agent seat — `POST /teams/:slug/members/:name/halt`. WHO may is decided by the
 * daemon (human-only; admin any agent, a non-admin only the agents they sponsor); the roster's
 * `can_halt` is that answer projected for this viewer, and the button renders from it alone.
 */
export function haltSeat(
  cfg: LiveConfig,
  seat: string,
  reason: string,
): Promise<{ member: string; halted: { at: number; by: string; reason: string } }> {
  return postAsWeb(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/members/${encodeURIComponent(seat)}/halt`,
    { reason },
  );
}

/**
 * ADR 516 increment 4: set a Team hold — `POST /teams/:slug/holds`. WHO may is the daemon's
 * (`authAdmin`, human by construction); the holds read's `can_set` is that answer projected for this
 * viewer, and the control renders from it alone.
 */
export function setHold(
  cfg: LiveConfig,
  body: { effect: HoldEffect; reason: string; for_ms: number },
): Promise<{ hold: Hold }> {
  return postAsWeb(cfg, `/teams/${encodeURIComponent(cfg.team)}/holds`, body);
}

/** ADR 516 increment 4: lift a hold early — `POST /teams/:slug/holds/:id/lift`. */
export function liftHold(cfg: LiveConfig, id: string): Promise<{ hold: Hold }> {
  return postAsWeb(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/holds/${encodeURIComponent(id)}/lift`,
  );
}

/** ADR 514: a human's own style — what `GET`/`PUT /members/me/style` answer (self only). */
export interface MyStyle {
  member: string;
  prefs: StylePrefsWire;
  resolved: {
    floor: StyleFloorWire;
    dials: StyleDialsWire;
    team_dials: StyleDialsWire;
    team_prose: string;
    human_prose: string;
    epoch: string;
  };
  /** The block a seat steered by this human reads, verbatim. */
  block: string;
}

/** ADR 514: read this viewer's own dials and prose. A seat is refused (403): agents have no style. */
export function getMyStyle(cfg: LiveConfig): Promise<MyStyle> {
  return apiGet(cfg, `/teams/${encodeURIComponent(cfg.team)}/members/me/style`);
}

/** ADR 514: replace this viewer's prefs whole — the route stores exactly what it is sent. */
export function putMyStyle(cfg: LiveConfig, prefs: StylePrefsWire): Promise<MyStyle> {
  return sendAsWeb(cfg, 'PUT', `/teams/${encodeURIComponent(cfg.team)}/members/me/style`, prefs);
}

/** ADR 443 §4–5: a human's own doorbell — what `GET`/`PUT /members/me/doorbell` answer (self only). */
export interface MyDoorbell {
  member: string;
  prefs: DoorbellPrefs;
  /** The sinks the team allows, and the ones it rings by default. */
  allow: DoorbellSink[];
  defaults: DoorbellSink[];
  /** Whether the team configured each off-machine URL — never the URL. */
  team_urls: { slack: boolean; webhook: boolean };
  /** Where an ask rings this human today, with these prefs. */
  route: DoorbellSink[];
}

/** Read this viewer's own doorbell. A seat is refused (403): agents have no doorbell. */
export function getMyDoorbell(cfg: LiveConfig): Promise<MyDoorbell> {
  return apiGet(cfg, `/teams/${encodeURIComponent(cfg.team)}/members/me/doorbell`);
}

/** Replace this viewer's doorbell prefs whole; the daemon answers with the stored result. */
export function putMyDoorbell(cfg: LiveConfig, prefs: DoorbellPrefs): Promise<MyDoorbell> {
  return sendAsWeb(cfg, 'PUT', `/teams/${encodeURIComponent(cfg.team)}/members/me/doorbell`, prefs);
}

/** SPEC A.6 Axis 2: set this viewer's own availability. `until` rides only `away`. */
export function setMyAvailability(
  cfg: LiveConfig,
  body: { status: 'available' | 'away' | 'dnd'; until?: number | null },
): Promise<{ member: MemberSummary }> {
  return postAsWeb(cfg, `/teams/${encodeURIComponent(cfg.team)}/availability`, body);
}

/** The style slice of a sparse policy override (ADR 185): only what an admin chose. */
export interface StylePolicyStored {
  floor?: Partial<StyleFloorWire>;
  defaults?: Partial<StyleDialsWire>;
  prose?: string;
}

/** `GET /policy` (admin only): the dense effective policy and the sparse stored doc beside it. */
export interface TeamPolicyRead {
  policy: { style: { floor: StyleFloorWire; defaults: StyleDialsWire; prose: string } };
  stored: { style?: StylePolicyStored } & Record<string, unknown>;
}

/** ADR 514: the team's policy, admin only — the daemon refuses anyone else (403). */
export function getTeamPolicy(cfg: LiveConfig): Promise<TeamPolicyRead> {
  return apiGet(cfg, `/teams/${encodeURIComponent(cfg.team)}/policy`);
}

/**
 * ADR 185 replace semantics: `stored` is the WHOLE sparse doc, so a caller merges into what it read
 * (every other key included) and sends it back — dropping a key here would reset it to its default.
 */
export function setTeamPolicy(
  cfg: LiveConfig,
  stored: TeamPolicyRead['stored'],
): Promise<TeamPolicyRead> {
  return postAsWeb(cfg, `/teams/${encodeURIComponent(cfg.team)}/policy`, stored);
}

/** ADR 501: lift a halt — `POST /teams/:slug/members/:name/resume`. */
export function resumeSeat(cfg: LiveConfig, seat: string): Promise<{ member: string; halted: null }> {
  return postAsWeb(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/members/${encodeURIComponent(seat)}/resume`,
  );
}

/**
 * Admin approve or deny a claim request (ADR 077).
 * Returns { request_id, decision, delivered }.
 */
export async function decideRequest(
  cfg: LiveConfig,
  requestId: string,
  decision:
    | { decision: 'approve'; lifetime: 'once' | 'ttl' | 'standing'; ttl_hours?: number }
    | { decision: 'deny' },
): Promise<{ request_id: string; decision: string; delivered: boolean }> {
  const res = await fetch(
    `/teams/${encodeURIComponent(cfg.team)}/requests/${encodeURIComponent(requestId)}/decide`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
        'x-musterd-surface': 'web',
      },
      body: JSON.stringify(decision),
    },
  );
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new AuditFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return json as { request_id: string; decision: string; delivered: boolean };
}

/**
 * Provision a hidden read-only observer seat (ADR 063). Lets the dashboard be "enter a team and watch"
 * — no pre-made seat. The seat is hidden from the roster and can't send. Returns the human credential
 * (mscr_) the v0.3 WS `claim` handshake authenticates with (ADR 077); the observer claims its **own**
 * seat, which is self-authorizing (no grant/approval).
 *
 * Unauthenticated **from a local peer only** — the daemon now enforces the localhost-trust this route
 * always claimed (ADR 134); off-machine callers need an admin credential.
 *
 * `scope` is the observer's grade (ADR 136): `'full'` (default) is the operator's own dashboard on
 * their own machine and sees the whole timeline; `'public'` sees team/broadcast traffic only and is
 * what a **shared watch-link** gets by default; `'broadcast'` (ADR 601/616) is a watch link shared for a
 * demo — see {@link acquireWatchLinkObserver}.
 */
export async function provisionObserver(
  team: string,
  name: string,
  scope: 'full' | WatchGrade,
  bearer: string,
): Promise<string> {
  const res = await fetch(`/teams/${encodeURIComponent(team)}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ name, kind: 'human', observer: true, observer_scope: scope }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const cred = (json as { human_credential?: string }).human_credential;
  if (!cred) throw new Error('observer provisioning did not return a credential (daemon too old?)');
  return cred;
}

export interface LiveHandlers {
  onEnvelope: (env: Envelope) => void;
  onPresence: (member: string, status: string, surface?: string) => void;
  /** A seat's tool-call pulse (ADR 660, SPEC A.25) — counts and a kind, at most every ~5 s per seat,
   * and nothing while the seat is idle; `live/pulse.ts` decides liveness from the frame's `ts`. */
  onPulse?: (pulse: SeatPulseFrame) => void;
  onStatus: (status: ConnStatus) => void;
  onError?: (message: string) => void;
  /** The WS `claim` was refused for a stale/invalid credential — recoverable by re-provisioning a fresh
   * observer (the route drops the cached credential and reconnects). When set, it's called *instead* of
   * `onError` for that case, so the view auto-heals rather than showing a dead-end. */
  onCredentialInvalid?: () => void;
}

/**
 * A self-healing live socket: `claim` (own observer seat, self-authorizing — ADR 077) → subscribe
 * `team-all` → stream `deliver`/`presence`, with a 15s heartbeat and capped exponential-backoff
 * reconnect. `close()` stops reconnecting. A `refused` (bad/stale credential) is terminal.
 */
export class LiveClient {
  private ws: WebSocket | undefined;
  private hb: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private backoff = 1000;

  constructor(
    private cfg: LiveConfig,
    private h: LiveHandlers,
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private open(): void {
    this.h.onStatus('connecting');
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: this.cfg.team,
          key: this.cfg.token,
          target: { seat: this.cfg.as },
          surface: 'web',
          provenance: 'session',
        }),
      );
    };

    ws.onmessage = (ev: MessageEvent) => {
      let frame: { type: string; [k: string]: unknown };
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      switch (frame.type) {
        case 'occupied':
          // The claim succeeded (own observer seat) — subscribe to the firehose + start heartbeating.
          ws.send(JSON.stringify({ type: 'subscribe', scope: 'team-all' }));
          this.hb = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
          }, 15_000);
          break;
        case 'subscribed':
          this.backoff = 1000; // a clean handshake resets backoff
          this.h.onStatus('live');
          break;
        case 'deliver':
          this.h.onEnvelope(frame.envelope as Envelope);
          break;
        case 'presence':
          this.h.onPresence(
            frame.member as string,
            frame.status as string,
            frame.surface as string | undefined,
          );
          break;
        case 'seat_pulse':
          this.h.onPulse?.(frame as SeatPulseFrame);
          break;
        case 'refused': {
          // A bad/stale credential (e.g. a wiped DB, an expired observer TTL, or the seat reclaimed).
          // Terminal for this socket — stop, then let the route re-provision a fresh observer and
          // reconnect (onCredentialInvalid) instead of dead-ending on the daemon's hint.
          this.stopped = true;
          this.h.onStatus('error');
          ws.close();
          if (this.h.onCredentialInvalid) {
            this.h.onCredentialInvalid();
          } else {
            const hint = typeof frame.hint === 'string' && frame.hint ? ` — ${frame.hint}` : '';
            this.h.onError?.(`${frame.message as string}${hint}`);
          }
          break;
        }
        case 'pending':
          // No grant → an admin must approve. Never happens for a self-claimed observer seat, but if it
          // does, keep the socket open (the server pushes occupied/refused on decision) and say so.
          this.h.onError?.(String(frame.message ?? 'claim pending — waiting for admin approval'));
          break;
        case 'error': {
          const code = frame.code as string;
          this.h.onError?.(frame.message as string);
          if (TERMINAL_CODES.has(code)) {
            this.stopped = true; // don't reconnect into an auth failure
            this.h.onStatus('error');
            ws.close();
          }
          break;
        }
      }
    };

    ws.onclose = () => {
      this.clearHeartbeat();
      if (this.stopped) {
        this.h.onStatus('closed');
        return;
      }
      this.h.onStatus('reconnecting');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires next and owns reconnect; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(this.backoff, 15_000);
    this.backoff = Math.min(this.backoff * 2, 15_000);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.hb) {
      clearInterval(this.hb);
      this.hb = undefined;
    }
  }
}
