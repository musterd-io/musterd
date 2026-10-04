import { homedir } from 'node:os';
import type { Parsed } from '../args.js';
import { loadConfig } from '../config.js';
import { buildCatalog } from '../launcher/catalog.js';
import {
  fetchRosters,
  liveFor,
  memberRowsFor,
  rosterKey,
  rosterTargets,
} from '../launcher/live.js';
import { renderSeatsList } from '../launcher/rows.js';
import { lastUsedAt, launcherFilePath, readLauncherFile } from '../launcher/store.js';

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
  const { members, missing } = memberRowsFor(catalog, rosters, config);
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
