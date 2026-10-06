import type { CalendarEntry, CalendarEntryInput } from '@musterd/protocol/calendar';
import { CalendarApiError, type CalendarApi } from './api';

/**
 * Local-first calendar (ADR 520 §4). The phone keeps every entry on the device and a queue of the
 * writes it has not yet delivered. A sync pulls the daemon's `?since` delta, then replays the queue.
 *
 * Conflict rule: the daemon's `updated_at` wins. Each queued edit remembers the `updated_at` it was
 * made against (`base`); if the daemon's copy moved past that while the phone was away, the local
 * edit is dropped and the sync report names it, so the person is told rather than silently undone.
 *
 * The queue holds at most one write per entry — a second edit folds into the first and keeps its
 * base, and deleting an entry that was only ever local cancels its create.
 */

export type PendingWrite =
  | { seq: number; op: 'create'; id: string; body: CalendarEntryInput; base: null }
  | { seq: number; op: 'replace'; id: string; body: CalendarEntryInput; base: number }
  | { seq: number; op: 'delete'; id: string; body: null; base: number };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewPendingWrite = DistributiveOmit<PendingWrite, 'seq'>;

/** The device store. `expo-sqlite` implements it on the phone; tests use `memoryStore`. */
export interface LocalStore {
  entries(): Promise<CalendarEntry[]>;
  putEntries(entries: readonly CalendarEntry[]): Promise<void>;
  deleteEntries(ids: readonly string[]): Promise<void>;
  /** The daemon's `now` from the last pull; null before the first one. */
  cursor(): Promise<number | null>;
  setCursor(cursor: number | null): Promise<void>;
  /** Queued writes, oldest first. */
  pending(): Promise<PendingWrite[]>;
  addPending(write: NewPendingWrite): Promise<void>;
  updatePending(write: PendingWrite): Promise<void>;
  deletePending(seq: number): Promise<void>;
}

/** An edit the sync threw away, and why — shown to the person, never swallowed. */
export interface Dropped {
  title: string;
  reason: string;
}

export interface SyncReport {
  /** The daemon could not be reached; the queue is intact. */
  offline: boolean;
  /** Queued writes delivered this sync. */
  pushed: number;
  dropped: Dropped[];
  /** A failure that is neither offline nor a refusal of one write (a 5xx, a malformed answer). */
  error: string | null;
}

const LOCAL_PREFIX = 'local-';

/** An entry made on this phone that the daemon has not yet assigned an id. */
export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_PREFIX);
}

function localId(now: number): string {
  return `${LOCAL_PREFIX}${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class LocalCalendar {
  constructor(
    private readonly store: LocalStore,
    /** The Member name stamped on entries made offline, until the daemon's copy replaces them. */
    private readonly me: string,
  ) {}

  entries(): Promise<CalendarEntry[]> {
    return this.store.entries();
  }

  private async pendingFor(id: string): Promise<PendingWrite | undefined> {
    return (await this.store.pending()).find((p) => p.id === id);
  }

  /** Create (`existing` null) or edit an entry on the device and queue the write. */
  async save(
    input: CalendarEntryInput,
    existing: CalendarEntry | null,
    now = Date.now(),
  ): Promise<CalendarEntry> {
    if (existing === null) {
      const id = localId(now);
      // The local id rides as source_ref, the daemon's idempotency key (ADR 519 §5): if a POST
      // commits but its answer is lost, the replay replaces that entry instead of adding a second.
      const body: CalendarEntryInput = { ...input, source_ref: input.source_ref ?? id };
      const entry: CalendarEntry = {
        ...body,
        id,
        created_by: this.me,
        created_at: now,
        updated_at: now,
      };
      await this.store.putEntries([entry]);
      await this.store.addPending({ op: 'create', id, body, base: null });
      return entry;
    }
    const entry: CalendarEntry = { ...existing, ...input };
    await this.store.putEntries([entry]);
    const pending = await this.pendingFor(existing.id);
    if (pending?.op === 'create' || pending?.op === 'replace') {
      await this.store.updatePending({ ...pending, body: input });
    } else {
      await this.store.addPending({
        op: 'replace',
        id: existing.id,
        body: input,
        base: existing.updated_at,
      });
    }
    return entry;
  }

  /** Delete on the device and queue the delete; a never-delivered create is simply cancelled. */
  async remove(entry: CalendarEntry): Promise<void> {
    await this.store.deleteEntries([entry.id]);
    const pending = await this.pendingFor(entry.id);
    if (pending?.op === 'create') {
      await this.store.deletePending(pending.seq);
      return;
    }
    if (pending?.op === 'replace') {
      await this.store.updatePending({
        seq: pending.seq,
        op: 'delete',
        id: entry.id,
        body: null,
        base: pending.base,
      });
      return;
    }
    if (pending === undefined) {
      await this.store.addPending({
        op: 'delete',
        id: entry.id,
        body: null,
        base: entry.updated_at,
      });
    }
  }

  /** Forget everything on the device — used when the server or Team setting changes. */
  async reset(): Promise<void> {
    const all = await this.store.entries();
    await this.store.deleteEntries(all.map((e) => e.id));
    for (const p of await this.store.pending()) await this.store.deletePending(p.seq);
    await this.store.setCursor(null);
  }

  /**
   * Pull, then replay. A refusal of one queued write drops that write (reported) and forces a full
   * re-read so the device shows the daemon's copy again; an unreachable daemon stops the replay
   * with the queue intact.
   */
  async sync(api: CalendarApi): Promise<SyncReport> {
    const report: SyncReport = { offline: false, pushed: 0, dropped: [], error: null };
    try {
      await this.pull(api, report);
      const refused = await this.replay(api, report);
      if (refused) {
        await this.store.setCursor(null);
        await this.pull(api, report);
      }
    } catch (err) {
      if (err instanceof CalendarApiError && err.unreachable) report.offline = true;
      else report.error = err instanceof Error ? err.message : String(err);
    }
    return report;
  }

  private async pull(api: CalendarApi, report: SyncReport): Promise<void> {
    const cursor = await this.store.cursor();
    const list = await api.list(cursor ?? undefined);
    const pending = new Map((await this.store.pending()).map((p) => [p.id, p]));
    const local = new Map((await this.store.entries()).map((e) => [e.id, e]));

    // A full read lists what exists; anything the device holds from the daemon that it no longer
    // lists was deleted while we were not looking.
    const deleted = new Set(list.deleted);
    if (cursor === null) {
      const listed = new Set(list.entries.map((e) => e.id));
      for (const id of local.keys()) if (!isLocalId(id) && !listed.has(id)) deleted.add(id);
    }

    const put: CalendarEntry[] = [];
    for (const e of list.entries) {
      const p = pending.get(e.id);
      if (p && p.op !== 'create') {
        if (e.updated_at <= p.base) continue; // the daemon has not moved; the queued write stands
        await this.store.deletePending(p.seq);
        report.dropped.push({
          title: e.title,
          reason:
            p.op === 'delete'
              ? 'changed on the daemon before your delete arrived — kept'
              : 'changed on the daemon while you were away — your edit was dropped',
        });
      }
      put.push(e);
    }
    for (const id of deleted) {
      const p = pending.get(id);
      if (p && p.op === 'replace') {
        await this.store.deletePending(p.seq);
        report.dropped.push({
          title: p.body.title,
          reason: 'deleted on the daemon — your edit was dropped',
        });
      } else if (p && p.op === 'delete') {
        await this.store.deletePending(p.seq);
      }
    }

    if (put.length > 0) await this.store.putEntries(put);
    if (deleted.size > 0) await this.store.deleteEntries([...deleted]);
    await this.store.setCursor(list.now);
  }

  /** Deliver the queue in order. Returns true when the daemon refused a write. */
  private async replay(api: CalendarApi, report: SyncReport): Promise<boolean> {
    let refused = false;
    for (const p of await this.store.pending()) {
      try {
        if (p.op === 'create') {
          const res = await api.create(p.body);
          await this.store.deleteEntries([p.id]);
          await this.store.putEntries([res.entry]);
        } else if (p.op === 'replace') {
          const res = await api.replace(p.id, p.body);
          await this.store.putEntries([res.entry]);
        } else {
          await api.remove(p.id);
        }
        await this.store.deletePending(p.seq);
        report.pushed++;
      } catch (err) {
        if (!(err instanceof CalendarApiError) || err.unreachable || err.status >= 500) throw err;
        await this.store.deletePending(p.seq);
        if (p.op === 'create') await this.store.deleteEntries([p.id]);
        if (err.status === 404 && p.op === 'delete') continue; // already gone: the goal is met
        refused = true;
        report.dropped.push({
          title: p.body?.title ?? 'a deleted entry',
          reason:
            err.status === 404
              ? 'deleted on the daemon — your edit was dropped'
              : `refused: ${err.message}`,
        });
      }
    }
    return refused;
  }
}

/** An in-memory `LocalStore` — the tests' device, and the shape the SQLite store mirrors. */
export function memoryStore(): LocalStore {
  const entries = new Map<string, CalendarEntry>();
  let cursor: number | null = null;
  let seq = 0;
  let queue: PendingWrite[] = [];
  return {
    entries: async () => [...entries.values()],
    putEntries: async (es) => {
      for (const e of es) entries.set(e.id, e);
    },
    deleteEntries: async (ids) => {
      for (const id of ids) entries.delete(id);
    },
    cursor: async () => cursor,
    setCursor: async (c) => {
      cursor = c;
    },
    pending: async () => [...queue],
    addPending: async (w) => {
      queue.push({ ...w, seq: ++seq } as PendingWrite);
    },
    updatePending: async (w) => {
      queue = queue.map((p) => (p.seq === w.seq ? w : p));
    },
    deletePending: async (s) => {
      queue = queue.filter((p) => p.seq !== s);
    },
  };
}
