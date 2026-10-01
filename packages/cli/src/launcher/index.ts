import type { Live } from './live.js';
import { initialState, type PickerEvent } from './picker/state.js';
import { runPicker, type PickerIO } from './picker/tty.js';
import { renderPicker } from './picker/view.js';
import { launcherFilePath, readLauncherFile, withSnapshot, writeLauncherFile } from './store.js';

/**
 * Bare `musterd` on a terminal (ADR 491 Decision 1). Paints from the snapshot first — this module's
 * static imports are zod, picocolors and node builtins only (`importClosure.test.ts`) — then loads
 * the catalog scan and the roster reads, which patch rows in place. `MUSTERD_PAINT_PROBE=1` renders
 * the first frame to stdout and reports the time since process start: the bench's first-paint probe.
 */
export async function openPicker(
  opts: {
    query?: string;
    /** Flags typed with an ambiguous name (`musterd stan -r`): they apply to the seat picked. */
    defaults?: { mode: 'fresh' | 'resume'; harness: string | null; force: boolean };
    io?: PickerIO;
    env?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const path = launcherFilePath(env);
  const state = initialState(readLauncherFile(path), opts.query ?? '', Date.now());
  if (env['MUSTERD_PAINT_PROBE'] === '1') {
    process.stdout.write(renderPicker(state, { cols: 80, rows: 24 }).join('\n') + '\n');
    process.stderr.write(`first-paint ${performance.now().toFixed(1)}ms\n`);
    return 0;
  }
  const outcome = await runPicker(
    state,
    opts.io ?? { input: process.stdin, output: process.stdout },
    (dispatch) => {
      void refresh(dispatch, path, opts.home);
    },
  );
  if (outcome.kind === 'quit') return outcome.code;
  if (outcome.kind === 'create') {
    process.stderr.write(
      `setting up ${outcome.member} in ${outcome.team}/${outcome.project} (fetching origin first)…\n`,
    );
    const [{ createSeat }, { buildCatalog }, { loadConfig }, os] = await Promise.all([
      import('./create.js'),
      import('./catalog.js'),
      import('../config.js'),
      import('node:os'),
    ]);
    const home = opts.home ?? os.homedir();
    const seats = buildCatalog({ home, config: loadConfig() }).seats;
    const seat = await createSeat({
      team: outcome.team,
      project: outcome.project,
      member: outcome.member,
      harnesses: outcome.harnesses,
      seats,
      home,
    });
    const { launchSeat } = await import('./byName.js');
    return launchSeat(seat, { mode: 'fresh', harness: outcome.harnesses[0] ?? null, force: true });
  }
  const { launchSeat } = await import('./byName.js');
  const d = opts.defaults;
  return launchSeat(outcome.seat, {
    mode: d?.mode === 'resume' ? 'resume' : outcome.mode,
    harness: d?.harness ?? outcome.harness,
    force: outcome.force || (d?.force ?? false),
  });
}

/** The post-paint work: scan, snapshot, roster reads. Every failure degrades to "offline". */
async function refresh(
  dispatch: (e: PickerEvent) => void,
  path: string,
  home?: string,
): Promise<void> {
  try {
    const [{ buildCatalog }, { loadConfig }, os] = await Promise.all([
      import('./catalog.js'),
      import('../config.js'),
      import('node:os'),
    ]);
    const catalog = buildCatalog({ home: home ?? os.homedir(), config: loadConfig() });
    dispatch({
      type: 'catalog',
      seats: catalog.seats,
      teams: catalog.teams,
      stale: catalog.stale.length,
      now: Date.now(),
    });
    try {
      writeLauncherFile(
        path,
        withSnapshot(readLauncherFile(path), {
          taken_at: catalog.taken_at,
          seats: catalog.seats,
          teams: catalog.teams,
        }),
      );
    } catch {
      // the snapshot is a cache
    }
    const { fetchRosters, liveFor, rosterKey, teamAgents } = await import('./live.js');
    const rosters = await fetchRosters(catalog.seats);
    const live: Record<string, Live> = {};
    const agents: Record<string, string[]> = {};
    let answered = catalog.seats.length === 0;
    const unknown: string[] = [];
    for (const seat of catalog.seats) {
      const members = rosters.get(rosterKey(seat)) ?? null;
      if (members) answered = true;
      else unknown.push(seat.address);
      if (members && !agents[seat.team]) agents[seat.team] = teamAgents(members);
      const l = liveFor(seat, members);
      if (l) live[seat.address] = l;
    }
    dispatch({
      type: 'live',
      live,
      status: answered ? 'ok' : 'offline',
      unknown,
      agents,
      now: Date.now(),
    });
  } catch {
    dispatch({ type: 'live', live: {}, status: 'offline', now: Date.now() });
  }
}
