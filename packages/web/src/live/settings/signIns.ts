import { LiveFetchError, apiGet, type LiveConfig } from '../client';
import {
  bindingDeviceName,
  fetchChannelBindings,
  revokeChannelBinding,
  type ChannelBinding,
} from '../pairingClient';

/**
 * "Where you're signed in" (unified sign-in spec §7, lane 01M6S2W39F): every device and app signed
 * in to this team as this member, in one list, each with Sign out. Today that is browsers (ADR 722
 * sessions), apps connected over MCP (OAuth chains) and paired phones. Terminals, API keys and
 * computers join as their lanes land. Words are the sign-in copy spec's §6.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** ADR 722 §3: a browser session idle this long is over, whatever its absolute expiry. */
const SESSION_IDLE_MS = 3 * DAY;

export interface BrowserSessionRow {
  id: string;
  label: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  revoked_at: number | null;
  /** The session this page's own token came from. */
  current?: boolean;
}

export interface ClientChainRow {
  chain_id: string;
  client_id: string;
  client_name: string;
  connected_at: number;
  last_used_at: number;
}

export type SignInKind = 'browser' | 'client' | 'phone';

export interface SignInRow {
  key: string;
  kind: SignInKind;
  /** What the server calls it: the session id, the chain id or the binding id. */
  id: string;
  device: string;
  how: string;
  lastUsedAt: number;
  current: boolean;
  action: 'Sign out';
}

/** `Active now` inside two minutes, then the coarse relative time /live uses elsewhere. */
export function lastUsedLabel(at: number, now: number): string {
  const age = Math.max(0, now - at);
  if (age < 2 * MIN) return 'Active now';
  if (age < HOUR) return `${Math.floor(age / MIN)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  return `${Math.floor(age / DAY)}d ago`;
}

export function signInRows(input: {
  sessions: readonly BrowserSessionRow[];
  clients: readonly ClientChainRow[];
  phones: readonly ChannelBinding[];
  now: number;
}): SignInRow[] {
  const { now } = input;
  const rows: SignInRow[] = [];
  for (const s of input.sessions) {
    if (s.revoked_at !== null || s.expires_at <= now || now - s.last_used_at > SESSION_IDLE_MS)
      continue;
    const current = s.current === true;
    rows.push({
      key: `browser:${s.id}`,
      kind: 'browser',
      id: s.id,
      device: current ? 'This browser' : s.label,
      how: 'Browser',
      lastUsedAt: current ? now : s.last_used_at,
      current,
      action: 'Sign out',
    });
  }
  for (const c of input.clients)
    rows.push({
      key: `client:${c.chain_id}`,
      kind: 'client',
      id: c.chain_id,
      device: 'Connected app',
      how: c.client_name,
      lastUsedAt: c.last_used_at,
      current: false,
      action: 'Sign out',
    });
  for (const p of input.phones) {
    if (p.channel !== 'app' || p.status !== 'active' || p.ended) continue;
    rows.push({
      key: `phone:${p.id}`,
      kind: 'phone',
      id: p.id,
      device: bindingDeviceName(p) ?? 'Phone',
      how: 'Phone',
      // A pairing records when it was made, not when it was last used.
      lastUsedAt: p.created_at,
      current: false,
      action: 'Sign out',
    });
  }
  return rows.sort((a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt - a.lastUsedAt);
}

// ── the wire ────────────────────────────────────────────────────────────────────────────────────

const memberPath = (cfg: LiveConfig, member: string) =>
  `/teams/${encodeURIComponent(cfg.team)}/members/${encodeURIComponent(member)}`;

async function apiDelete(cfg: LiveConfig, path: string): Promise<void> {
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${cfg.token}`, 'x-musterd-surface': 'web' },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = (text ? (JSON.parse(text) as { error?: { code?: string; message?: string } }) : {})
      .error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
}

/** Every kind, read in parallel; a kind this member cannot read (no route, not a human) is empty. */
export async function fetchSignIns(
  cfg: LiveConfig,
  member: string,
): Promise<{
  sessions: BrowserSessionRow[];
  clients: ClientChainRow[];
  phones: ChannelBinding[];
}> {
  const [sessions, clients, phones] = await Promise.all([
    apiGet<{ sessions: BrowserSessionRow[] }>(cfg, `${memberPath(cfg, member)}/sessions`)
      .then((r) => r.sessions)
      .catch(() => []),
    apiGet<{ clients: ClientChainRow[] }>(cfg, `${memberPath(cfg, member)}/clients`)
      .then((r) => r.clients)
      .catch(() => []),
    fetchChannelBindings(cfg).catch(() => []),
  ]);
  return { sessions, clients, phones };
}

/** Sign one row out, by its kind's own route. */
export async function signOutRow(cfg: LiveConfig, member: string, row: SignInRow): Promise<void> {
  if (row.kind === 'browser')
    return apiDelete(cfg, `${memberPath(cfg, member)}/sessions/${encodeURIComponent(row.id)}`);
  if (row.kind === 'client')
    return apiDelete(cfg, `${memberPath(cfg, member)}/clients/${encodeURIComponent(row.id)}`);
  await revokeChannelBinding(cfg, row.id);
}
