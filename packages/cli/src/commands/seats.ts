import { homedir } from 'node:os';
import type { Parsed } from '../args.js';
import { loadConfig } from '../config.js';
import { buildCatalog } from '../launcher/catalog.js';
import { fetchRosters, liveFor, rosterKey } from '../launcher/live.js';
import { renderSeatsList } from '../launcher/rows.js';
import { lastUsedAt, launcherFilePath, readLauncherFile } from '../launcher/store.js';

/**
 * `musterd seats [--json]` (ADR 491 Decision 7): every seat on this machine, as the launcher sees
 * them — the catalog plus one time-boxed roster read per team. `--json` is the read model a future
 * face (the macOS app) consumes; it carries no secret.
 */
export async function seatsCommand(
  parsed: Parsed,
  deps: { home?: string; fetch?: typeof fetch; now?: number } = {},
): Promise<number> {
  const catalog = buildCatalog({ home: deps.home ?? homedir(), config: loadConfig() });
  const rosters = await fetchRosters(catalog.seats, undefined, deps.fetch);
  const file = readLauncherFile(launcherFilePath());
  const entries = catalog.seats.map((seat) => ({
    seat,
    live: liveFor(seat, rosters.get(rosterKey(seat)) ?? null),
    lastUsed: lastUsedAt(seat, file),
  }));
  if (parsed.flags['json'] === true) {
    process.stdout.write(
      JSON.stringify({
        seats: entries.map(({ seat, live, lastUsed }) => ({ ...seat, live, last_used: lastUsed })),
        teams: catalog.teams,
        stale: catalog.stale,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    renderSeatsList(entries, catalog.stale.length, deps.now ?? Date.now()) + '\n',
  );
  return 0;
}
