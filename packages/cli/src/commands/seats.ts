import { homedir } from 'node:os';
import type { Parsed } from '../args.js';
import { loadConfig, type Config } from '../config.js';
import { buildCatalog, type Catalog } from '../launcher/catalog.js';
import {
  fetchRosters,
  liveFor,
  rosterKey,
  rosterTargets,
  teamRows,
  type RosterPage,
} from '../launcher/live.js';
import { renderSeatsList } from '../launcher/rows.js';
import {
  lastUsedAt,
  launcherFilePath,
  type MemberEntry,
  readLauncherFile,
} from '../launcher/store.js';

/**
 * `musterd seats [--json]` (ADR 491 Decision 7, ADR 503): every member of every team this machine
 * knows, with where each lives and what this machine can do about it, plus the Workspaces here —
 * the catalog and one time-boxed roster read per team. `--json` is the read model a future face
 * (the macOS app) consumes; it carries no secret.
 */
export async function seatsCommand(
  parsed: Parsed,
  deps: { home?: string; fetch?: typeof fetch; now?: number } = {},
): Promise<number> {
  const config = loadConfig();
  const catalog = buildCatalog({ home: deps.home ?? homedir(), config });
  const rosters = await fetchRosters(
    rosterTargets(catalog.seats, catalog.teams, config.server),
    undefined,
    deps.fetch,
  );
  const file = readLauncherFile(launcherFilePath());
  const entries = catalog.seats.map((seat) => ({
    seat,
    live: liveFor(seat, rosters.get(rosterKey(seat))?.members ?? null),
    lastUsed: lastUsedAt(seat, file),
  }));
  const { members, missing } = memberRows(catalog, rosters, config);
  if (parsed.flags['json'] === true) {
    process.stdout.write(
      JSON.stringify({
        seats: entries.map(({ seat, live, lastUsed }) => ({ ...seat, live, last_used: lastUsed })),
        members,
        teams: catalog.teams,
        roster_missing: missing,
        stale: catalog.stale,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    renderSeatsList(entries, catalog.stale.length, deps.now ?? Date.now(), {
      members,
      rosterMissing: missing,
    }) + '\n',
  );
  return 0;
}

/** Who this machine is on `team`: its identity, else the one working human Workspace here. */
export function viewerNameFor(
  team: string,
  config: Pick<Config, 'identities' | 'knownIdentities'>,
  seats: Catalog['seats'],
): string | null {
  const identity =
    config.identities[team]?.name ?? config.knownIdentities.find((i) => i.team === team)?.name;
  if (identity) return identity;
  const humans = seats.filter((s) => s.team === team && s.kind === 'human' && s.problem === null);
  return humans.length === 1 ? humans[0]!.member : null;
}

/** The roster-first rows across every team that answered, and the teams that did not. */
export function memberRows(
  catalog: Catalog,
  rosters: ReadonlyMap<string, RosterPage | null>,
  config: Pick<Config, 'server' | 'identities' | 'knownIdentities'>,
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
