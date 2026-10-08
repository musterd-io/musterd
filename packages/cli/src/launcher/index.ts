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
  if (outcome.kind === 'wake') {
    // ADR 503: ⏎ on a seat resident elsewhere rings its doorbell as the viewer — from the viewer's
    // own Workspace here, never a vault (ADR 442).
    const [{ wakeMember }, { viewerNameFor }, { buildCatalog }, { loadConfig }, os] =
      await Promise.all([
        import('./wake.js'),
        import('./live.js'),
        import('./catalog.js'),
        import('../config.js'),
        import('node:os'),
      ]);
    const config = loadConfig();
    const seats = buildCatalog({ home: opts.home ?? os.homedir(), config }).seats;
    return wakeMember(outcome.entry, seats, viewerNameFor(outcome.entry.team, config, seats));
  }
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
    // A take-over / watch outcome leaves the live check to `launchSeat` (ADR 546): it finds the
    // wake, and if it cannot, falls back to the plain question rather than guessing.
    force: 'force' in outcome ? outcome.force || (d?.force ?? false) : false,
    ...(outcome.kind === 'take-over' ? { takeOver: true } : {}),
    ...(outcome.kind === 'watch' ? { watch: true } : {}),
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
    const config = loadConfig();
    const catalog = buildCatalog({ home: home ?? os.homedir(), config });
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
    const { fetchRosters, liveFor, memberRowsFor, membersByTeam, rosterKey, rosterTargets } =
      await import('./live.js');
    const rosters = await fetchRosters(rosterTargets(catalog.seats, catalog.teams, config.server));
    const live: Record<string, Live> = {};
    let answered = catalog.seats.length === 0;
    const unknown: string[] = [];
    for (const seat of catalog.seats) {
      const members = rosters.get(rosterKey(seat))?.members ?? null;
      if (members) answered = true;
      else unknown.push(seat.address);
      const l = liveFor(seat, members);
      if (l) live[seat.address] = l;
    }
    // ADR 503 Decision 1: the roster-first rows, cached in the snapshot for the next first paint.
    const { members } = memberRowsFor(catalog, rosters, config);
    dispatch({
      type: 'live',
      live,
      status: answered ? 'ok' : 'offline',
      unknown,
      members: membersByTeam(members),
      now: Date.now(),
    });
    if (members.length) {
      try {
        writeLauncherFile(
          path,
          withSnapshot(readLauncherFile(path), {
            taken_at: catalog.taken_at,
            seats: catalog.seats,
            teams: catalog.teams,
            members,
          }),
        );
      } catch {
        // the snapshot is a cache
      }
    }
  } catch {
    dispatch({ type: 'live', live: {}, status: 'offline', now: Date.now() });
  }
}
