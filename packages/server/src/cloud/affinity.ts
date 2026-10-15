import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { log } from '../log.js';

/**
 * Team affinity (ADR 608): on Cloud, ONE server owns a team at a time. Every request and WebSocket
 * for a team is served by its owner; a server that is not the owner answers with Fly's
 * `fly-replay` header and the proxy replays the request there. Inside the owner nothing changes —
 * the Hub stays in-process and every seat rule (displacement, claim approval, the grace reap) keeps
 * its single-process semantics. The trade: a team is bounded by one machine's capacity (the §8.1
 * runs put that at 75 humans + 75 agents + 75 viewers at p95 ~0.6 s), and a team's sockets move
 * when its owner changes (clients reconnect in ~2 s, as every bench run showed).
 *
 * The owner is picked by RENDEZVOUS HASHING the team slug over the live machine list: each machine
 * scores `sha256(slug \0 machine)` and the highest score owns the team. Removing a machine moves
 * only the teams it owned; adding one moves ~1/N of every other machine's teams. No registry, no
 * election, no shared state — every server computes the same answer from the same list.
 *
 * The list comes from Fly's internal DNS (`vms.<app>.internal` TXT: `"<id> <region>,…"`), which
 * names STARTED machines, and is re-read every REFRESH_MS. During a deploy two servers may hold
 * different lists for a few seconds, so a team can be briefly double-owned or replayed in a loop;
 * `fly-replay-src` (set by the proxy on a replayed request) breaks the loop: a request that was
 * already replayed once is served where it lands.
 *
 * Fail open to single-server behaviour: with no `FLY_MACHINE_ID` (self-hosted, tests, a laptop in
 * cloud mode) or when the list cannot be read, every team is local. That is the behaviour the
 * one-machine Cloud has had since 2026-10-02.
 */

export const REFRESH_MS = 5_000;
/** The served-team set is bounded: a flood of invented team hosts must not grow memory. */
export const SERVED_MAX = 10_000;

/**
 * The machine a `fly-replay-src` header says replayed this request, or null. The header is set by
 * the proxy on a replayed request, but a client can send one too, so it is trusted only when it
 * names a machine in the live list other than this one — a spoofed value with no real machine
 * behind it does not buy a bypass of the owner rule.
 */
export function replaySource(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const m = /(?:^|;)\s*instance=([A-Za-z0-9_-]+)/.exec(raw);
  return m ? m[1]! : null;
}

export interface AffinityDecision {
  /** Serve here. */
  local: boolean;
  /** The machine to replay to when not local. */
  owner: string | null;
}

/** The pure core: which machine of `machines` owns `team`. Deterministic; empty list ⇒ null. */
export function ownerFor(team: string, machines: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = '';
  for (const m of machines) {
    const score = createHash('sha256').update(`${team}\0${m}`).digest('hex');
    if (best === null || score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The decision for one request. `replayed` is whether the proxy already replayed it (the
 * `fly-replay-src` header is present): then it is served here whatever the list says, so two
 * servers disagreeing about the list cannot bounce a request between them.
 */
export function decide(
  team: string | null,
  self: string | null,
  machines: readonly string[],
  replayed: boolean | string | null,
): AffinityDecision {
  if (team === null || self === null) return { local: true, owner: null };
  // `replayed` as a machine id (from `replaySource`) is honoured only for a real peer; `true` is the
  // caller vouching for it (tests).
  const vouched =
    replayed === true ||
    (typeof replayed === 'string' && replayed !== self && machines.includes(replayed));
  if (vouched) return { local: true, owner: null };
  const owner = ownerFor(team, machines);
  if (owner === null || owner === self) return { local: true, owner: self };
  // A list that does not contain this machine is stale (we are running); serve rather than replay
  // to a list we are not on — the next refresh will include us.
  if (!machines.includes(self)) return { local: true, owner: null };
  return { local: false, owner };
}

/** Parse Fly's `vms.<app>.internal` TXT answer: `["<id> <region>,<id> <region>"]` → ids. */
export function parseVmsTxt(records: readonly (readonly string[])[]): string[] {
  const ids: string[] = [];
  for (const rec of records) {
    for (const entry of rec.join('').split(',')) {
      const id = entry.trim().split(/\s+/)[0];
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)].sort();
}

export interface AffinityOptions {
  /** This machine's id (`FLY_MACHINE_ID`). Null ⇒ affinity off, everything local. */
  self: string | null;
  /** The live machine list. Defaults to Fly internal DNS for `app`. */
  machines?: () => Promise<string[]>;
  /** The Fly app whose machines are the peer set (`FLY_APP_NAME`). */
  app?: string | null;
  /** Called with the teams this server no longer owns after a list change (close their sockets). */
  onLost?: (teams: string[], newOwnerOf: (team: string) => string | null) => void;
  refreshMs?: number;
}

/** The running affinity state: a cached machine list, refreshed on a timer. */
export class Affinity {
  readonly self: string | null;
  private list: string[] = [];
  private readonly fetch: () => Promise<string[]>;
  private timer: NodeJS.Timeout | null = null;
  private warned = false;
  private readonly onLost: AffinityOptions['onLost'];
  private readonly refreshMs: number;
  /** Teams this server has served since the last refresh — the set a list change is checked against. */
  private served = new Set<string>();

  constructor(opts: AffinityOptions) {
    this.self = opts.self;
    this.onLost = opts.onLost;
    this.refreshMs = opts.refreshMs ?? REFRESH_MS;
    const app = opts.app ?? null;
    this.fetch =
      opts.machines ??
      (async () => {
        if (!app) return [];
        return parseVmsTxt(await dns.resolveTxt(`vms.${app}.internal`));
      });
    if (this.self !== null) this.list = [this.self];
  }

  /** The machines as last read (this machine alone until the first refresh). */
  get machines(): readonly string[] {
    return this.list;
  }

  get enabled(): boolean {
    return this.self !== null;
  }

  decide(team: string | null, replayed: boolean | string | null): AffinityDecision {
    const d = decide(team, this.self, this.list, replayed);
    // Record only a team this server OWNS and served — that is the set a list change can take
    // away. A replayed or foreign team is not recorded, and the set is bounded (oldest out).
    if (team !== null && d.local && d.owner === this.self) {
      this.served.delete(team);
      this.served.add(team);
      if (this.served.size > SERVED_MAX) {
        const oldest = this.served.values().next().value;
        if (oldest !== undefined) this.served.delete(oldest);
      }
    }
    return d;
  }

  /** Read the list once; a failure keeps the previous list and logs once. */
  async refresh(): Promise<void> {
    if (this.self === null) return;
    let next: string[];
    try {
      next = await this.fetch();
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        log.warn({ msg: 'affinity_list_unreadable', err: String(err) });
      }
      return;
    }
    if (next.length === 0) return; // an empty answer is never evidence that we are alone
    const before = this.list;
    this.list = [...next].sort();
    if (before.join(',') === this.list.join(',')) return;
    log.info({ msg: 'affinity_machines', machines: this.list, self: this.self });
    const lost = [...this.served].filter((t) => ownerFor(t, this.list) !== this.self);
    for (const t of lost) this.served.delete(t);
    if (lost.length > 0 && this.onLost) this.onLost(lost, (t) => ownerFor(t, this.list));
  }

  start(): void {
    if (this.self === null || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The affinity for this process from its environment: on only under Fly with a machine id. */
export function affinityFromEnv(env: Record<string, string | undefined>): AffinityOptions {
  return { self: env['FLY_MACHINE_ID']?.trim() || null, app: env['FLY_APP_NAME']?.trim() || null };
}

/** The response headers that make the proxy replay this request to `owner`. */
export function replayHeaders(owner: string): Record<string, string> {
  return { 'fly-replay': `instance=${owner}` };
}
