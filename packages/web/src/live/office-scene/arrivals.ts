import type { OfficeNode } from './types';

/**
 * Who is NEW in the room (lane 01M3F81DD9, spec §4.2) — a pure diff of two consecutive rosters.
 *
 * `created`: a name the previous roster did not have. `firstOnline`: a Member going online whose
 * previous entry was offline with `offline_reason: 'unknown'` — the server's never-connected value
 * (offline.wire.ts). Nothing is remembered anywhere: a live viewer sees the moment, a reload does not
 * replay it, and the first roster the scene sees (`prev === null`) is never an arrival — the same
 * no-stampede rule `actors.setHomes` keeps for walk-ins.
 *
 * Fed the SCENE's previous map, not the network's last response: a failed refetch followed by a good
 * one must not replay what already played.
 */
export type ArrivalSubject = Pick<
  OfficeNode,
  'name' | 'kind' | 'service' | 'presence' | 'offline_reason' | 'hue' | 'created_at' | 'sponsored_by'
>;

export interface Arrival {
  kind: 'created' | 'firstOnline';
  name: string;
  memberKind: 'agent' | 'human';
  hue: number | null;
  sponsor: string | null;
  /** Online right now — a `created` arrival that is already online plays Act 1 folded into Act 2. */
  online: boolean;
}

function arrival(kind: Arrival['kind'], n: ArrivalSubject): Arrival {
  return {
    kind,
    name: n.name,
    memberKind: n.kind,
    hue: n.hue ?? null,
    sponsor: n.sponsored_by ?? null,
    online: n.presence === 'online',
  };
}

/**
 * A never-connected Member counts as a newcomer only this long after being created. `unknown` is also
 * what a lapsed AMBIENT presence reads (a member present only through CLI/HTTP calls, ADR 057) — found
 * on a throwaway daemon, where a human active a minute earlier was welcomed again on their next command.
 */
export const FIRST_ONLINE_WINDOW_MS = 24 * 3_600_000;

/** What the diff needs beyond the two rosters to tell a first arrival from a return. */
export interface ArrivalContext {
  now: number;
  /** Everyone this viewer has seen online (or away) since the page loaded — none of them is new. */
  seenOnline: ReadonlySet<string>;
}

export function diffArrivals(
  prev: ReadonlyMap<string, ArrivalSubject> | null,
  next: readonly ArrivalSubject[],
  ctx?: ArrivalContext,
): Arrival[] {
  if (prev === null) return [];
  const out: Arrival[] = [];
  for (const n of next) {
    if (n.service) continue; // ledger seats are not arrivals
    const before = prev.get(n.name);
    if (!before) {
      out.push(arrival('created', n));
    } else if (
      before.presence === 'offline' &&
      before.offline_reason === 'unknown' &&
      n.presence === 'online' &&
      (!ctx || isNewcomer(n, ctx))
    ) {
      out.push(arrival('firstOnline', n));
    }
  }
  return out;
}

/** Not seen online this session, and created recently (or of unknown age — an older daemon, a preview). */
function isNewcomer(n: ArrivalSubject, ctx: ArrivalContext): boolean {
  if (ctx.seenOnline.has(n.name)) return false;
  return n.created_at === null || ctx.now - n.created_at < FIRST_ONLINE_WINDOW_MS;
}
