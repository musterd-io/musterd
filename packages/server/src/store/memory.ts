import type { MemoryEnvelope } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { appendReplicatedEvent } from './audit.js';

/**
 * Seat memory (ADR 093): a daemon-private, seat-scoped continuity blob — the working state a
 * returning occupant needs (what it was doing, decisions mid-flight, where it left off). One row per
 * member, last-write-wins, no history. The occupant writes it explicitly (`memory_save`); musterd
 * stores, never composes. Delivery is envelope-on-occupy / body-on-demand: {@link memoryEnvelope}
 * rides the occupied frame (headline + age + size, never the body); {@link getMemory} is the explicit
 * read. Lives in the daemon DB, never the git seat-file — half-done context (or secrets pasted into a
 * note) must not land in repo history (the ADR 058 durable/live line).
 */

/** Body cap in UTF-8 bytes — cheap per-session context, rejected above with the limit named. */
export const MEMORY_BODY_MAX_BYTES = 8192;
/** Headline cap in characters — the commit-subject convention that keeps the occupy line one line. */
export const MEMORY_HEADLINE_MAX_CHARS = 120;

export interface Memory {
  headline: string;
  body: string;
  saved_at: number;
}

interface MemoryRow {
  headline: string;
  body: string;
  saved_at: number;
}

/**
 * Save (upsert, last-write-wins) the seat's memory, stamping `saved_at`. Enforces both caps —
 * headline by character count, body by UTF-8 byte length — and rejects an oversize/empty input with
 * the limit named. Never logs or audits the content itself (sizes only; hard rule 5).
 */
export async function saveMemory(
  db: Driver,
  memberId: string,
  input: { headline: string; body: string },
): Promise<void> {
  const headline = input.headline;
  if (headline.length < 1) {
    throw new MusterdError('bad_request', 'memory headline is required');
  }
  if (headline.length > MEMORY_HEADLINE_MAX_CHARS) {
    throw new MusterdError(
      'bad_request',
      `memory headline is ${headline.length} chars; the limit is ${MEMORY_HEADLINE_MAX_CHARS}`,
    );
  }
  const bodyBytes = Buffer.byteLength(input.body, 'utf8');
  if (bodyBytes > MEMORY_BODY_MAX_BYTES) {
    throw new MusterdError(
      'bad_request',
      `memory body is ${bodyBytes} bytes; the limit is ${MEMORY_BODY_MAX_BYTES}`,
    );
  }
  await db.run(
    `INSERT INTO seat_memory (member_id, headline, body, saved_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       headline = excluded.headline,
       body     = excluded.body,
       saved_at = excluded.saved_at`,
    [memberId, headline, input.body, Date.now()],
  );
}

/** The full note for a seat — the explicit body read — or null if nothing is saved. */
export async function getMemory(db: Driver, memberId: string): Promise<Memory | null> {
  const row = await db.get<MemoryRow>(
    'SELECT headline, body, saved_at FROM seat_memory WHERE member_id = ?',
    [memberId],
  );
  return row ? { headline: row.headline, body: row.body, saved_at: row.saved_at } : null;
}

/**
 * The envelope that rides the occupied frame: headline + age + size, **never the body** (ADR 093 §3).
 * `size_bytes` is the UTF-8 byte length of the body so the agent sees the fetch cost.
 */
export async function memoryEnvelope(db: Driver, memberId: string): Promise<MemoryEnvelope | null> {
  const row = await db.get<MemoryRow>(
    'SELECT headline, body, saved_at FROM seat_memory WHERE member_id = ?',
    [memberId],
  );
  if (!row) return null;
  return {
    headline: row.headline,
    saved_at: row.saved_at,
    size_bytes: Buffer.byteLength(row.body, 'utf8'),
  };
}

/** Clear the seat's memory. Returns true if a row existed (idempotent — false when already empty). */
export async function clearMemory(db: Driver, memberId: string): Promise<boolean> {
  const info = await db.run('DELETE FROM seat_memory WHERE member_id = ?', [memberId]);
  return info.changes > 0;
}

/**
 * Save the seat's memory AND stamp it for replication (ADR 366, residence-2 census gap 2).
 *
 * ADR 325 named `seat_memory` residence 2 with an LWW merge and shipped neither, so a human who
 * trusts a second laptop (ADR 358) found no continuity there — the one thing seat memory exists to
 * carry across a gap. The write and its event are one transaction, as everywhere else.
 *
 * The event carries the BODY, because a headline is not continuity. Two consequences, both stated
 * in ADR 366 rather than discovered later: the audit log now holds memory bodies (daemon-side only,
 * never git — the ADR 058 line is unmoved), and a blob ADR 093 called history-less gains an
 * implicit history in that log, bounded by the 8 KiB cap.
 */
export async function applyMemorySave(
  db: Driver,
  teamId: string,
  seat: { id: string; name: string },
  input: { headline: string; body: string },
): Promise<void> {
  await db.tx(async (t) => {
    await saveMemory(t, seat.id, input);
    const saved = (await getMemory(t, seat.id))!;
    await appendReplicatedEvent(t, teamId, {
      actor: seat.name,
      action: 'continuity.memory_saved',
      target: seat.name,
      result: 'allow',
      detail: { headline: saved.headline, body: saved.body, saved_at: saved.saved_at },
    });
  });
}

/**
 * Clear the seat's memory and stamp the clearing (ADR 366). Replicated for the obvious reason: a
 * note a seat deliberately dropped must not walk back in from a peer that still holds it.
 * `cleared_at` is what the fold compares against the local `saved_at` — same LWW rule, one clock
 * per fact, the origin's.
 */
export async function applyMemoryClear(
  db: Driver,
  teamId: string,
  seat: { id: string; name: string },
): Promise<boolean> {
  return db.tx(async (t) => {
    const cleared = await clearMemory(t, seat.id);
    await appendReplicatedEvent(t, teamId, {
      actor: seat.name,
      action: 'continuity.memory_cleared',
      target: seat.name,
      result: 'allow',
      detail: { cleared_at: Date.now(), had_memory: cleared },
    });
    return cleared;
  });
}
