import { homedir } from 'node:os';
import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
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
/**
 * The flags `musterd seats` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
/**
 * The flags `musterd seats` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const SEATS_FLAGS = [] as const;

export async function seatsCommand(
  parsed: Parsed,
  deps: { home?: string; fetch?: typeof fetch; now?: number } = {},
): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...SEATS_FLAGS],
    'the flags `musterd seats` takes are listed by `musterd help seats`',
  );
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
