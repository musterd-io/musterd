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

export function diffArrivals(
  prev: ReadonlyMap<string, ArrivalSubject> | null,
  next: readonly ArrivalSubject[],
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
      n.presence === 'online'
    ) {
      out.push(arrival('firstOnline', n));
    }
  }
  return out;
}

/** The corner holds this many polaroids — more is a noticeboard, not a welcome. */
export const CORNER_MAX = 3;
/** How long a deskless newcomer stays pinned. */
export const CORNER_WINDOW_MS = 24 * 3_600_000;

/**
 * The wallboard's *new arrivals* corner (spec §3.1): Members created in the last 24 h who hold no desk.
 * Derived from the roster every bake, never stored — so it survives a reload as a still.
 */
export function newArrivalsCorner(
  nodes: readonly ArrivalSubject[],
  deskHolders: ReadonlySet<string>,
  now: number,
): { name: string; hue: number | null }[] {
  return nodes
    .filter(
      (n) =>
        !n.service &&
        n.offline_reason !== 'left_team' &&
        !deskHolders.has(n.name) &&
        n.created_at !== null &&
        now - n.created_at < CORNER_WINDOW_MS,
    )
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, CORNER_MAX)
    .map((n) => ({ name: n.name, hue: n.hue ?? null }));
}
