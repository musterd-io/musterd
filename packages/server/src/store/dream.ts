import type { Driver } from '../db/driver.js';
import { getMemberById } from './members.js';
import { getMemory } from './memory.js';
import type { MemberRow, MessageRow } from './rows.js';
import { truncateBytes, truncateChars } from './wakeContextBody.js';

/**
 * Goal dreaming, lane 2 — what a dream sees, and what it may write (ADR 494).
 *
 * A seat woken with provenance `dream` has nothing directed waiting: it is there to re-read its own
 * day. So its packet is not the wake packet's thread + ledger but the day's record for the lanes it
 * owns, its seat note, and the insights the team saved since its last dream — the raw material lane
 * 3's consolidation skill turns into insights and wiki pages. Like the wake packet it is a projection
 * over canonical rows, derived at read time and fitted to a byte budget; nothing here is stored.
 *
 * The write fence is the other half: a dream may save insights, write wiki pages and its own note.
 * Never code, never a lane transition, never an act that asks something of another member — a dream
 * that could do those would be an unscheduled work session wearing a cheaper label.
 */

export const DREAM_BUDGET = {
  /** The whole packet, UTF-8 bytes of its JSON. Twice the wake packet's: a dream reads, it doesn't answer. */
  limit_bytes: 24_576,
  memory: 3_072,
  act_body_chars: 600,
  /** Newest-first cap per lane before the byte fit drops the oldest. */
  lane_acts: 40,
  lanes: 12,
  learned: 30,
  /** Default look-back when the seat has never dreamed. */
  default_since_ms: 24 * 60 * 60 * 1000,
} as const;

export interface DreamAct {
  id: string;
  from: string;
  act: string;
  ts: number;
  body: string;
  truncated: boolean;
}

export interface DreamLane {
  id: string;
  title: string;
  state: string;
  acts: DreamAct[];
  /** Acts on this lane in the window that the budget left out (oldest first to go). */
  omitted: number;
}

export interface DreamInsight {
  id: string;
  from: string;
  headline: string;
  body: string;
  tags: string[];
  ts: number;
}

export interface DreamPacket {
  seat: string;
  /** The window the dream re-reads: `[since, until)`. */
  since: number;
  until: number;
  memory?: { body: string; truncated: boolean };
  lanes: DreamLane[];
  /** Insights the team saved in the window — what lane 4's digest reads as "what was learned". */
  learned: DreamInsight[];
}

export interface BuiltDreamPacket {
  packet: DreamPacket;
  used_bytes: number;
  truncated: boolean;
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * When the seat last dreamed: the newest act it sent from a `dream` presence. The window starts
 * there so two nights never re-read the same day; a seat that has never dreamed looks back a day.
 */
export async function lastDreamAt(
  db: Driver,
  teamId: string,
  seatId: string,
): Promise<number | null> {
  const row = await db.get<{ ts: number }>(
    `SELECT ts FROM messages WHERE team_id = ? AND from_member = ? AND from_provenance = 'dream'
      ORDER BY ts DESC LIMIT 1`,
    [teamId, seatId],
  );
  return row?.ts ?? null;
}

/**
 * Is this member dreaming right now — is its live presence a `dream` one? The same read
 * `insertMessage` stamps `from_provenance` from, so the fence and the stamp can never disagree.
 */
export async function isDreaming(db: Driver, memberId: string): Promise<boolean> {
  const row = await db.get<{ provenance: string | null }>(
    `SELECT provenance FROM presence
      WHERE member_id = ? AND held_until IS NULL
      ORDER BY last_seen_at DESC, created_at DESC LIMIT 1`,
    [memberId],
  );
  return row?.provenance === 'dream';
}

export async function buildDreamPacket(
  db: Driver,
  team: { id: string },
  seat: MemberRow,
  opts: { since?: number; now?: number } = {},
): Promise<BuiltDreamPacket> {
  const B = DREAM_BUDGET;
  const until = opts.now ?? Date.now();
  const since =
    opts.since ?? (await lastDreamAt(db, team.id, seat.id)) ?? until - B.default_since_ms;
  let truncated = false;

  const names = new Map<string, string>();
  const nameOf = async (memberId: string): Promise<string> => {
    const hit = names.get(memberId);
    if (hit !== undefined) return hit;
    const name = (await getMemberById(db, memberId))?.name ?? memberId;
    names.set(memberId, name);
    return name;
  };
  const toAct = async (r: MessageRow): Promise<DreamAct> => {
    const cut = truncateChars(r.body, B.act_body_chars);
    if (cut.truncated) truncated = true;
    return {
      id: r.id,
      from: await nameOf(r.from_member),
      act: r.act,
      ts: r.ts,
      body: cut.text,
      truncated: cut.truncated,
    };
  };

  const packet: DreamPacket = { seat: seat.name, since, until, lanes: [], learned: [] };

  // 1. the seat's own note
  const memory = await getMemory(db, seat.id);
  if (memory) {
    const cut = truncateBytes(memory.body, B.memory);
    packet.memory = { body: cut.text, truncated: cut.truncated };
    if (cut.truncated) truncated = true;
  }

  // 2. the day's record for its own lanes — every lane it owns that moved in the window, whatever
  //    its state now (a lane that landed today is the day's best material). An act is "on" a lane
  //    the way the wake packet's lane read has it: the lane id appears in its body or meta.
  const lanes = await db.all<{ id: string; title: string; state: string }>(
    `SELECT id, title, state FROM lanes
      WHERE team_id = ? AND owner_seat = ? AND updated_at >= ?
      ORDER BY updated_at DESC`,
    [team.id, seat.name, since],
  );
  if (lanes.length > B.lanes) truncated = true;
  for (const l of lanes.slice(0, B.lanes)) {
    const rows = await db.all<MessageRow>(
      `SELECT * FROM messages
        WHERE team_id = ? AND ts >= ? AND ts < ? AND act <> 'insight'
          AND (instr(body, ?) > 0 OR instr(COALESCE(meta, ''), ?) > 0)
        ORDER BY ts DESC`,
      [team.id, since, until, l.id, l.id],
    );
    const kept = rows.slice(0, B.lane_acts).reverse();
    packet.lanes.push({
      id: l.id,
      title: l.title,
      state: l.state,
      acts: await Promise.all(kept.map(toAct)),
      omitted: rows.length - kept.length,
    });
    if (rows.length > kept.length) truncated = true;
  }

  // 3. what the team learned in the window — every seat's insights, not just its own
  const insights = await db.all<MessageRow>(
    `SELECT * FROM messages WHERE team_id = ? AND act = 'insight' AND ts >= ? AND ts < ?
      ORDER BY ts DESC`,
    [team.id, since, until],
  );
  if (insights.length > B.learned) truncated = true;
  packet.learned = await Promise.all(
    insights
      .slice(0, B.learned)
      .reverse()
      .map(async (r) => {
        const meta = JSON.parse(r.meta ?? '{}') as { headline?: string; tags?: string[] };
        const cut = truncateChars(r.body, B.act_body_chars);
        if (cut.truncated) truncated = true;
        return {
          id: r.id,
          from: await nameOf(r.from_member),
          headline: meta.headline ?? '',
          body: cut.text,
          tags: meta.tags ?? [],
          ts: r.ts,
        };
      }),
  );

  // 4. fit the whole packet: drop the oldest lane act anywhere first, then the oldest insight.
  //    The note is never dropped — it is what makes tonight's dream continuous with last night's.
  let used = bytesOf(packet);
  while (used > B.limit_bytes) {
    const oldest = packet.lanes
      .filter((l) => l.acts.length > 0)
      .sort((a, b) => a.acts[0]!.ts - b.acts[0]!.ts)[0];
    if (oldest) {
      oldest.acts.shift();
      oldest.omitted++;
    } else if (packet.learned.length > 0) {
      packet.learned.shift();
    } else break;
    truncated = true;
    used = bytesOf(packet);
  }

  return { packet, used_bytes: used, truncated };
}

/**
 * The write fence. A dream may: save an insight; save its OWN seat note; write a file under
 * `docs/wiki/**` (lane 3 promotes through a PR that `wiki:check` gates). Everything else is
 * refused with a reason the session can read and act on.
 */
export type DreamWrite =
  | { kind: 'act'; act: string }
  | { kind: 'memory'; seat: string }
  | { kind: 'file'; path: string }
  | { kind: 'lane' }
  | { kind: 'other'; what: string };

export type DreamVerdict = { ok: true } | { ok: false; reason: string };

const WIKI = /^docs\/wiki\/[^\0]+\.md$/;

export function dreamMayWrite(seat: string, w: DreamWrite): DreamVerdict {
  switch (w.kind) {
    case 'act':
      return w.act === 'insight'
        ? { ok: true }
        : { ok: false, reason: `a dream sends only insight acts, not ${w.act}` };
    case 'memory':
      return w.seat === seat
        ? { ok: true }
        : { ok: false, reason: `a dream writes only its own note, not ${w.seat}'s` };
    case 'file': {
      const p = w.path.replace(/^\.\//, '');
      return WIKI.test(p) && !p.split('/').includes('..')
        ? { ok: true }
        : { ok: false, reason: `a dream writes only docs/wiki/**/*.md, never code (${w.path})` };
    }
    case 'lane':
      return { ok: false, reason: 'a dream never moves a lane' };
    case 'other':
      return { ok: false, reason: `a dream may not ${w.what}` };
  }
}
