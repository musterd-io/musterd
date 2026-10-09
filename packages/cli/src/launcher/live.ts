import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BINDING_DIR,
  MemberSummarySchema,
  WAKE_LEASE_FILE,
  WakeLeaseFileSchema,
  type MemberSummary,
} from '@musterd/protocol';
import { z } from 'zod';
import { canonicalServer, isLoopbackServer } from '../host/registry.js';
import { serverHost } from './address.js';
import type { Can, MemberEntry, Seat, TeamEntry, Where } from './store.js';
import { pidAlive } from './yield.js';

/** The config fields the roster-first rows need — a structural slice so no caller loads config.ts. */
export interface ViewerConfig {
  server: string;
  identities: Record<string, { name: string }>;
  knownIdentities: readonly { team: string; name: string }[];
}

/** The time box for one roster read (ADR 491 §5.1). The local daemon answers in ~45 ms. */
export const ROSTER_TIMEOUT_MS = 300;

/** Where a seat is live, from its team's roster (ADR 491 Decision 6). */
export interface Live {
  where: 'here' | 'elsewhere';
  /** `here`, or the other machine's label. */
  label: string;
  surface: string;
  since: number | null;
  /**
   * Present only when the live Presence is a wake (`provenance: 'wake'`, ADR 543): why musterd
   * started it, from the roster's `wake_for` — null when the daemon could not say (an older daemon,
   * or a lease minted on another node). Absent for every session a person opened.
   */
  wake?: WakeFor | null;
}

/** Why a wake happened, as the roster carries it (ADR 543). */
export type WakeFor = NonNullable<MemberSummary['presences'][number]['wake_for']>;

/** The answering daemon's own node for the team (ADR 503 §4) — what `here` is compared against. */
export interface RosterNode {
  id: string;
  label: string;
}

/** One roster page: the members, and the node of the daemon that answered. */
export interface RosterPage {
  members: MemberSummary[];
  node: RosterNode | null;
}

const RosterSchema = z
  .object({
    members: z.array(MemberSummarySchema),
    node: z.object({ id: z.string().min(1), label: z.string() }).nullish(),
  })
  .passthrough();

/**
 * One UNAUTHENTICATED roster read, time-boxed. Unauthenticated on purpose: an authenticated client
 * may claim a seat per request (`claimSeatPerRequest`) and so write Presence, while the roster
 * route answers anonymous reads without touching anyone. Null on any failure — refused, timed out,
 * not JSON, off-schema — so a daemon that is down or wedged costs at most `timeoutMs`.
 */
export async function fetchRosterPage(
  server: string,
  team: string,
  timeoutMs: number = ROSTER_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<RosterPage | null> {
  try {
    const res = await fetchImpl(
      `${server.replace(/\/+$/, '')}/teams/${encodeURIComponent(team)}/members`,
      {
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return null;
    const parsed = RosterSchema.safeParse(await res.json());
    return parsed.success ? { members: parsed.data.members, node: parsed.data.node ?? null } : null;
  } catch {
    return null;
  }
}

/** The members alone — what a live-seat check needs. */
export async function fetchRoster(
  server: string,
  team: string,
  timeoutMs: number = ROSTER_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<MemberSummary[] | null> {
  return (await fetchRosterPage(server, team, timeoutMs, fetchImpl))?.members ?? null;
}

export function rosterKey(seat: Pick<Seat, 'server' | 'team'>): string {
  return `${canonicalServer(seat.server)}|${seat.team}`;
}

/**
 * Every (server, team) the catalog should read a roster for (ADR 503 Decision 1): each seat's own
 * server, and — for a team this machine knows only by identity, with no Workspace — the
 * configured default server. One entry per distinct key.
 */
export function rosterTargets(
  seats: readonly Seat[],
  teams: readonly TeamEntry[],
  defaultServer: string,
): { server: string; team: string }[] {
  const wanted = new Map<string, { server: string; team: string }>();
  for (const s of seats) if (s.server) wanted.set(rosterKey(s), { server: s.server, team: s.team });
  for (const t of teams) {
    if (t.here || !defaultServer) continue;
    const target = { server: defaultServer, team: t.team };
    if (!wanted.has(rosterKey(target))) wanted.set(rosterKey(target), target);
  }
  return [...wanted.values()];
}

/** One roster read per distinct (server, team), in parallel. */
export async function fetchRosters(
  targets: readonly { server: string; team: string }[],
  timeoutMs: number = ROSTER_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, RosterPage | null>> {
  const out = new Map<string, RosterPage | null>();
  await Promise.all(
    targets.map(async (t) => {
      out.set(rosterKey(t), await fetchRosterPage(t.server, t.team, timeoutMs, fetchImpl));
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
    ...(p.provenance === 'wake' ? { wake: p.wake_for ?? null } : {}),
  };
}

/** A wake running on this machine that a person could take over (ADR 546). */
export interface LocalWake {
  lease_id: string;
  pid: number;
  /** The wake's conversation. Null when an older host wrote none — take over cannot resume then. */
  session_id: string | null;
  harness: string;
  started_at: number;
  workspace: string;
  /** A loop inside the host process (the native harness): `pid` is the host's, never signalled, and
   *  there is no conversation to resume (ADR 546, lane 6/6). */
  in_process?: boolean;
}

/**
 * The wake that holds this seat's folder on this machine, found through the lease file the host
 * writes beside `binding.json` (ADR 354/546). Null — "no wake here" — unless EVERY check holds: the
 * roster says a wake is live here, the file parses, it has not expired, and the pid it names is
 * alive. A crashed host's leftover file, an expired lease or a reused pid must never read as a wake,
 * because the answer decides whom the launcher signals.
 */
export function localWake(
  seat: Seat,
  live: Live | null,
  deps: { alive?: (pid: number) => boolean; now?: () => number } = {},
): LocalWake | null {
  if (!live || live.where !== 'here' || live.wake === undefined) return null;
  try {
    const parsed = WakeLeaseFileSchema.safeParse(
      JSON.parse(readFileSync(join(seat.path, BINDING_DIR, WAKE_LEASE_FILE), 'utf8')),
    );
    if (!parsed.success) return null;
    const f = parsed.data;
    if ((deps.now ?? Date.now)() >= f.expires_at) return null;
    if (!(deps.alive ?? pidAlive)(f.spawner_pid)) return null;
    return {
      lease_id: f.lease_id,
      pid: f.spawner_pid,
      session_id: f.session_id ?? null,
      harness: f.harness,
      started_at: f.started_at,
      workspace: seat.path,
      ...(f.in_process ? { in_process: true } : {}),
    };
  } catch {
    return null;
  }
}

/** The team's agent members, sorted — what "on the team · not here" draws from (increment 4). */
export function teamAgents(members: readonly MemberSummary[]): string[] {
  return members
    .filter((m) => m.kind === 'agent')
    .map((m) => m.name)
    .sort();
}

/** Where a member lives (ADR 503 Decision 2): residence first, then a live presence, else nowhere. */
export interface Placed {
  where: Where;
  node: string | null;
  label: string | null;
}

/**
 * `here` is the answering daemon's own node — a loopback daemon's node IS this machine. A presence
 * with no `node` on a loopback daemon is likewise here. The label is the node's, never a hostname
 * this machine guessed (two machines named `mac` is what the second-machine run hit).
 */
export function whereOf(m: MemberSummary, node: RosterNode | null, server: string): Placed {
  const local = isLoopbackServer(server);
  const r = m.residence ?? null;
  if (r) {
    if (r.kind === 'cloud') return { where: 'cloud', node: r.node, label: r.node_label };
    if (local && node && r.node === node.id) return { where: 'here', node: r.node, label: null };
    return { where: 'node', node: r.node, label: r.node_label };
  }
  const p = m.presences[0];
  if (p) {
    if (local && (!p.node || (node && p.node === node.id)))
      return { where: 'here', node: node?.id ?? null, label: null };
    return { where: 'node', node: p.node ?? null, label: p.node_label ?? serverHost(server) };
  }
  return { where: 'nowhere', node: null, label: null };
}

export interface CanInput {
  placed: Placed;
  /** A Workspace for this member exists on this machine. */
  workspace: boolean;
  /** The viewer's roster entry on this team, when this machine holds an identity for it. */
  viewer: MemberSummary | null;
  /** The viewer has a working human Workspace here for this team (the `setup` precondition). */
  viewerSeatHere: boolean;
}

/**
 * ADR 503 Decision 2, the `can` table. Sponsorship is ADR 456 `sponsored_by`; a human is their own
 * sponsor; an admin may wake anyone. A seat resident on another node is NEVER `setup` from here.
 */
export function canOf(m: MemberSummary, i: CanInput): Can {
  const { where } = i.placed;
  if (i.workspace && (where === 'here' || where === 'nowhere')) return 'launch';
  if (where === 'node' || where === 'cloud') {
    const v = i.viewer;
    const admin = v?.roles.includes('admin') ?? false;
    const sponsor = v !== null && (m.sponsored_by === v.id || m.id === v.id);
    return m.wakeable === true && (admin || sponsor) ? 'wake' : 'none';
  }
  // Only an agent is set up from the front door: a service seat is provisioned by its own command,
  // and a human seat by `musterd human <you>`.
  if (where === 'nowhere' && !i.workspace && i.viewerSeatHere && m.kind === 'agent') return 'setup';
  return 'none';
}

/**
 * The roster-first rows for one team (ADR 503 Decision 1): every member once, overlaid with the
 * Workspaces here. `viewerName` is who this machine is on the team (its identity), or null.
 */
export function teamRows(
  team: string,
  page: RosterPage,
  server: string,
  seats: readonly Seat[],
  viewerName: string | null,
): MemberEntry[] {
  const here = seats.filter((s) => s.team === team);
  const viewer = viewerName ? (page.members.find((m) => m.name === viewerName) ?? null) : null;
  const viewerSeatHere = here.some(
    (s) => s.kind === 'human' && s.problem === null && (!viewerName || s.member === viewerName),
  );
  return page.members
    .map((m): MemberEntry => {
      const seat = here.find((s) => s.member === m.name) ?? null;
      const placed = whereOf(m, page.node, server);
      return {
        team,
        member: m.name,
        kind: m.kind === 'human' ? 'human' : 'agent',
        address: seat?.address ?? null,
        where: placed.where,
        node: placed.node,
        where_label: placed.label,
        can: canOf(m, {
          placed,
          workspace: seat !== null && seat.problem === null,
          viewer,
          viewerSeatHere,
        }),
      };
    })
    .sort((a, b) => a.member.localeCompare(b.member));
}

/** Who this machine is on `team`: its identity, else the one working human Workspace here. */
export function viewerNameFor(
  team: string,
  config: Pick<ViewerConfig, 'identities' | 'knownIdentities'>,
  seats: readonly Seat[],
): string | null {
  const identity =
    config.identities[team]?.name ?? config.knownIdentities.find((i) => i.team === team)?.name;
  if (identity) return identity;
  const humans = seats.filter((s) => s.team === team && s.kind === 'human' && s.problem === null);
  return humans.length === 1 ? humans[0]!.member : null;
}

/** The roster-first rows across every team that answered, and the teams that did not. */
export function memberRowsFor(
  catalog: { seats: readonly Seat[]; teams: readonly TeamEntry[] },
  rosters: ReadonlyMap<string, RosterPage | null>,
  config: ViewerConfig,
): { members: MemberEntry[]; missing: string[] } {
  const members: MemberEntry[] = [];
  const missing: string[] = [];
  for (const { server, team } of rosterTargets(catalog.seats, catalog.teams, config.server)) {
    const page = rosters.get(rosterKey({ server, team })) ?? null;
    if (!page) {
      missing.push(team);
      continue;
    }
    members.push(
      ...teamRows(team, page, server, catalog.seats, viewerNameFor(team, config, catalog.seats)),
    );
  }
  return { members, missing: [...new Set(missing)].sort() };
}

/** The rows grouped by team — the picker's shape. */
export function membersByTeam(members: readonly MemberEntry[]): Record<string, MemberEntry[]> {
  const out: Record<string, MemberEntry[]> = {};
  for (const m of members) (out[m.team] ??= []).push(m);
  return out;
}
