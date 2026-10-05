/**
 * Calendar entries (ADR 519, SPEC A.16): the Team's calendar as team data.
 *
 * Any active Member reads and writes; the caller has authorized that. Every write that changes a row
 * is one audit row in the same transaction (`calendar.entry_written` / `calendar.entry_deleted`,
 * `{id, by}`), so the ledger says who changed what. A write whose body matches the stored entry
 * changes nothing and audits nothing — that is what makes the one-time import idempotent (§5).
 *
 * Deletes are real deletes. A `?since` delta reads them back from the delete audit rows, which is
 * why the delete audit is the required append, not the best-effort one: a delete the ledger lost
 * would be a delete the phone never hears about.
 *
 * Local to the daemon that took the write — no sync kind. The calendar's daemon is the one the phone
 * points at (ADR 519 §4); a joiner-hub split for it is not a case this increment has.
 */
import {
  CalendarEntrySchema,
  compareCalendarEntries,
  type CalendarEntry,
  type CalendarEntryInput,
  type CalendarWriteOutcome,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { appendAuditRequired } from './audit.js';

interface CalendarRow {
  id: string;
  title: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  tz: string;
  kind: string;
  status: string | null;
  place: string;
  url: string | null;
  note: string;
  pick: number;
  source: string;
  source_ref: string | null;
  created_by: string;
  created_at: number | string;
  updated_at: number | string;
}

const COLUMNS =
  'id, title, date, start_time, end_time, tz, kind, status, place, url, note, pick, source, source_ref, created_by, created_at, updated_at';

function toEntry(row: CalendarRow): CalendarEntry {
  return CalendarEntrySchema.parse({
    id: row.id,
    title: row.title,
    date: row.date,
    start: row.start_time,
    end: row.end_time,
    tz: row.tz,
    kind: row.kind,
    status: row.status,
    place: row.place,
    url: row.url,
    note: row.note,
    pick: Number(row.pick) === 1,
    source: row.source,
    source_ref: row.source_ref,
    created_by: row.created_by,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  });
}

/** Does `input` say exactly what `entry` already says? Then a write is `unchanged`. */
function sameAs(entry: CalendarEntry, input: CalendarEntryInput): boolean {
  return (
    entry.title === input.title &&
    entry.date === input.date &&
    entry.start === input.start &&
    entry.end === input.end &&
    entry.tz === input.tz &&
    entry.kind === input.kind &&
    entry.status === input.status &&
    entry.place === input.place &&
    entry.url === input.url &&
    entry.note === input.note &&
    entry.pick === input.pick &&
    entry.source === input.source &&
    entry.source_ref === input.source_ref
  );
}

/** Every entry, in calendar order. */
export async function listCalendar(db: Driver, teamId: string): Promise<CalendarEntry[]> {
  const rows = await db.all<CalendarRow>(
    `SELECT ${COLUMNS} FROM calendar_entries WHERE team_id = ?`,
    [teamId],
  );
  return rows.map(toEntry).sort(compareCalendarEntries);
}

/**
 * The delta since `since` (ms, the daemon's clock): entries written at or after it, and the ids
 * deleted at or after it. Inclusive on purpose — a write in the same millisecond as the previous
 * read's `now` is sent twice rather than never.
 */
export async function listCalendarSince(
  db: Driver,
  teamId: string,
  since: number,
): Promise<{ entries: CalendarEntry[]; deleted: string[] }> {
  const rows = await db.all<CalendarRow>(
    `SELECT ${COLUMNS} FROM calendar_entries WHERE team_id = ? AND updated_at >= ?`,
    [teamId, since],
  );
  const gone = await db.all<{ target: string }>(
    `SELECT target FROM audit WHERE team_id = ? AND action = 'calendar.entry_deleted' AND ts >= ?
       ORDER BY ts ASC`,
    [teamId, since],
  );
  return {
    entries: rows.map(toEntry).sort(compareCalendarEntries),
    deleted: [...new Set(gone.map((g) => g.target))],
  };
}

async function getEntry(db: Driver, teamId: string, id: string): Promise<CalendarEntry | null> {
  const row = await db.get<CalendarRow>(
    `SELECT ${COLUMNS} FROM calendar_entries WHERE team_id = ? AND id = ?`,
    [teamId, id],
  );
  return row ? toEntry(row) : null;
}

async function getBySourceRef(
  db: Driver,
  teamId: string,
  sourceRef: string,
): Promise<CalendarEntry | null> {
  const row = await db.get<CalendarRow>(
    `SELECT ${COLUMNS} FROM calendar_entries WHERE team_id = ? AND source_ref = ?`,
    [teamId, sourceRef],
  );
  return row ? toEntry(row) : null;
}

/**
 * Create an entry — or, when `source_ref` names one already here, replace that one. The import posts
 * every artifact entry with its document id as `source_ref`, so its second run lands as `unchanged`
 * throughout.
 */
export async function createCalendarEntry(
  db: Driver,
  teamId: string,
  actor: string,
  input: CalendarEntryInput,
  now: number = Date.now(),
): Promise<{ entry: CalendarEntry; outcome: CalendarWriteOutcome }> {
  return db.tx(async (t) => {
    if (input.source_ref !== null) {
      const existing = await getBySourceRef(t, teamId, input.source_ref);
      if (existing) return writeOver(t, teamId, actor, existing, input, now);
    }
    const entry: CalendarEntry = {
      id: ulid(now),
      ...input,
      created_by: actor,
      created_at: now,
      updated_at: now,
    };
    await t.run(
      `INSERT INTO calendar_entries (team_id, ${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        teamId,
        entry.id,
        entry.title,
        entry.date,
        entry.start,
        entry.end,
        entry.tz,
        entry.kind,
        entry.status,
        entry.place,
        entry.url,
        entry.note,
        entry.pick ? 1 : 0,
        entry.source,
        entry.source_ref,
        entry.created_by,
        entry.created_at,
        entry.updated_at,
      ],
    );
    await audited(t, teamId, actor, 'calendar.entry_written', entry.id);
    return { entry, outcome: 'created' as const };
  });
}

/** Replace entry `id` with `input` — `not_found` for an id this Team does not have. */
export async function replaceCalendarEntry(
  db: Driver,
  teamId: string,
  actor: string,
  id: string,
  input: CalendarEntryInput,
  now: number = Date.now(),
): Promise<{ entry: CalendarEntry; outcome: CalendarWriteOutcome }> {
  return db.tx(async (t) => {
    const existing = await getEntry(t, teamId, id);
    if (!existing) throw new MusterdError('not_found', `no calendar entry "${id}"`);
    if (input.source_ref !== null && input.source_ref !== existing.source_ref) {
      const holder = await getBySourceRef(t, teamId, input.source_ref);
      if (holder) {
        throw new MusterdError(
          'conflict',
          `source_ref "${input.source_ref}" already belongs to calendar entry "${holder.id}"`,
        );
      }
    }
    return writeOver(t, teamId, actor, existing, input, now);
  });
}

async function writeOver(
  t: Driver,
  teamId: string,
  actor: string,
  existing: CalendarEntry,
  input: CalendarEntryInput,
  now: number,
): Promise<{ entry: CalendarEntry; outcome: CalendarWriteOutcome }> {
  if (sameAs(existing, input)) return { entry: existing, outcome: 'unchanged' };
  // `updated_at` never moves backwards: a delta reader keyed on it must see this write.
  const updated_at = Math.max(now, existing.updated_at);
  const entry: CalendarEntry = { ...existing, ...input, updated_at };
  await t.run(
    `UPDATE calendar_entries SET title = ?, date = ?, start_time = ?, end_time = ?, tz = ?, kind = ?,
       status = ?, place = ?, url = ?, note = ?, pick = ?, source = ?, source_ref = ?, updated_at = ?
     WHERE team_id = ? AND id = ?`,
    [
      entry.title,
      entry.date,
      entry.start,
      entry.end,
      entry.tz,
      entry.kind,
      entry.status,
      entry.place,
      entry.url,
      entry.note,
      entry.pick ? 1 : 0,
      entry.source,
      entry.source_ref,
      entry.updated_at,
      teamId,
      entry.id,
    ],
  );
  await audited(t, teamId, actor, 'calendar.entry_written', entry.id);
  return { entry, outcome: 'updated' };
}

/** Delete entry `id` — `not_found` for an id this Team does not have. */
export async function deleteCalendarEntry(
  db: Driver,
  teamId: string,
  actor: string,
  id: string,
): Promise<void> {
  await db.tx(async (t) => {
    const existing = await getEntry(t, teamId, id);
    if (!existing) throw new MusterdError('not_found', `no calendar entry "${id}"`);
    await t.run('DELETE FROM calendar_entries WHERE team_id = ? AND id = ?', [teamId, id]);
    await audited(t, teamId, actor, 'calendar.entry_deleted', id);
  });
}

async function audited(
  t: Driver,
  teamId: string,
  actor: string,
  action: 'calendar.entry_written' | 'calendar.entry_deleted',
  id: string,
): Promise<void> {
  await appendAuditRequired(t, teamId, {
    actor,
    action,
    target: id,
    result: 'allow',
    detail: { id, by: actor },
  });
}
