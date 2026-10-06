import type { CalendarEntry, CalendarEntryInput } from '@musterd/protocol/calendar';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { createCalendarApi, normalizeServerUrl, type Connection } from '../lib/api';
import { LocalCalendar, type SyncReport } from '../lib/sync';
import { clearConnection, loadConnection, saveConnection } from './settings';
import { openSqliteStore } from './sqlite-store';

/**
 * The one place screens get the calendar from. It opens the device store, reads the connection
 * from the Keychain, and syncs on launch, on every return to the foreground, and after every write
 * (ADR 520 §4). Screens render `entries` — the device copy — so the app works with no daemon in
 * reach, and `report` says what the last sync did.
 */

interface CalendarState {
  ready: boolean;
  connection: Connection | null;
  entries: CalendarEntry[];
  syncing: boolean;
  report: SyncReport | null;
  lastSyncedAt: number | null;
  refresh(): Promise<void>;
  save(input: CalendarEntryInput, existing: CalendarEntry | null): Promise<void>;
  remove(entry: CalendarEntry): Promise<void>;
  /** Check the connection against the daemon, then keep it; a different daemon or Team starts clean. */
  connect(conn: Connection): Promise<void>;
  disconnect(): Promise<void>;
}

const Ctx = createContext<CalendarState | null>(null);

export function useCalendar(): CalendarState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCalendar outside CalendarProvider');
  return v;
}

export function CalendarProvider({ children }: { children: ReactNode }) {
  const cal = useRef<LocalCalendar | null>(null);
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const reload = useCallback(async () => {
    if (cal.current) setEntries(await cal.current.entries());
  }, []);

  const syncWith = useCallback(
    async (conn: Connection | null) => {
      if (!cal.current || !conn) return;
      // One sync at a time: a foreground and a save landing together share the run.
      if (inFlight.current) return inFlight.current;
      const run = (async () => {
        setSyncing(true);
        try {
          const r = await cal.current!.sync(createCalendarApi(conn));
          setReport(r);
          if (!r.offline && r.error === null) setLastSyncedAt(Date.now());
          await reload();
        } finally {
          setSyncing(false);
          inFlight.current = null;
        }
      })();
      inFlight.current = run;
      return run;
    },
    [reload],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      const store = await openSqliteStore();
      cal.current = new LocalCalendar(store, 'me');
      const conn = await loadConnection();
      if (!alive) return;
      setConnection(conn);
      await reload();
      setReady(true);
      await syncWith(conn);
    })();
    return () => {
      alive = false;
    };
  }, [reload, syncWith]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void syncWith(connection);
    });
    return () => sub.remove();
  }, [connection, syncWith]);

  const value = useMemo<CalendarState>(
    () => ({
      ready,
      connection,
      entries,
      syncing,
      report,
      lastSyncedAt,
      refresh: () => syncWith(connection),
      async save(input, existing) {
        await cal.current!.save(input, existing);
        await reload();
        void syncWith(connection);
      },
      async remove(entry) {
        await cal.current!.remove(entry);
        await reload();
        void syncWith(connection);
      },
      async connect(raw) {
        const conn = { ...raw, server: normalizeServerUrl(raw.server), team: raw.team.trim() };
        await createCalendarApi(conn).list(); // refuses a wrong URL, Team or credential before we keep it
        if (connection && (connection.server !== conn.server || connection.team !== conn.team)) {
          await cal.current!.reset();
        }
        await saveConnection(conn);
        setConnection(conn);
        setReport(null);
        await syncWith(conn);
      },
      async disconnect() {
        await clearConnection();
        await cal.current!.reset();
        setConnection(null);
        setReport(null);
        setLastSyncedAt(null);
        await reload();
      },
    }),
    [ready, connection, entries, syncing, report, lastSyncedAt, reload, syncWith],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
