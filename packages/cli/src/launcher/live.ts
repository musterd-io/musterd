import { MemberSummarySchema, type MemberSummary } from '@musterd/protocol';
import { z } from 'zod';
import { canonicalServer, isLoopbackServer } from '../host/registry.js';
import { serverHost } from './address.js';
import type { Seat } from './store.js';

/** The time box for one roster read (ADR 491 §5.1). The local daemon answers in ~45 ms. */
export const ROSTER_TIMEOUT_MS = 300;

/** Where a seat is live, from its team's roster (ADR 491 Decision 6). */
export interface Live {
  where: 'here' | 'elsewhere';
  /** `here`, or the other machine's label. */
  label: string;
  surface: string;
  since: number | null;
}

const RosterSchema = z.object({ members: z.array(MemberSummarySchema) }).passthrough();

/**
 * One UNAUTHENTICATED roster read, time-boxed. Unauthenticated on purpose: an authenticated client
 * may claim a seat per request (`claimSeatPerRequest`) and so write Presence, while the roster
 * route answers anonymous reads without touching anyone. Null on any failure — refused, timed out,
 * not JSON, off-schema — so a daemon that is down or wedged costs at most `timeoutMs`.
 */
export async function fetchRoster(
  server: string,
  team: string,
  timeoutMs: number = ROSTER_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<MemberSummary[] | null> {
  try {
    const res = await fetchImpl(
      `${server.replace(/\/+$/, '')}/teams/${encodeURIComponent(team)}/members`,
      {
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return null;
    const parsed = RosterSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.members : null;
  } catch {
    return null;
  }
}

export function rosterKey(seat: Pick<Seat, 'server' | 'team'>): string {
  return `${canonicalServer(seat.server)}|${seat.team}`;
}

/** One roster read per distinct (server, team), in parallel. */
export async function fetchRosters(
  seats: readonly Seat[],
  timeoutMs: number = ROSTER_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, MemberSummary[] | null>> {
  const wanted = new Map<string, { server: string; team: string }>();
  for (const s of seats) if (s.server) wanted.set(rosterKey(s), { server: s.server, team: s.team });
  const out = new Map<string, MemberSummary[] | null>();
  await Promise.all(
    [...wanted].map(async ([key, { server, team }]) => {
      out.set(key, await fetchRoster(server, team, timeoutMs, fetchImpl));
    }),
  );
  return out;
}

/** The seat's first live Presence, if any. `node` absent means the queried daemon's own machine. */
export function liveFor(seat: Seat, members: readonly MemberSummary[] | null): Live | null {
  const p = members?.find((m) => m.name === seat.member)?.presences[0];
  if (!p) return null;
  const here = !p.node && isLoopbackServer(seat.server);
  return {
    where: here ? 'here' : 'elsewhere',
    label: here ? 'here' : (p.node_label ?? serverHost(seat.server)),
    surface: p.surface,
    since: p.attached_at ?? null,
  };
}

/** The team's agent members, sorted — what "on the team · not here" draws from (increment 4). */
export function teamAgents(members: readonly MemberSummary[]): string[] {
  return members
    .filter((m) => m.kind === 'agent')
    .map((m) => m.name)
    .sort();
}
