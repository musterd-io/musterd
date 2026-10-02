import { makeEnvelope, type WaitingOnEntry } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { answeredByAnyoneSql, resolvedThreadSql } from '../store/discharge.js';
import { waitingOn } from '../store/insights.js';
import { insertMessage } from '../store/messages.js';
import type { MessageRow } from '../store/rows.js';

/**
 * Dreaming lane 4 — the morning digest (goal `dreaming`).
 *
 * At the start of working hours one scheduled seat posts what the night
 * learned: the insights saved since the night began, what each seat is still
 * waiting on, and which asks went unanswered. Pure reads over the message log
 * plus {@link waitingOn} — the same unresolved-thread predicate the waiting
 * ledger uses, so the digest and the ledger cannot disagree about what is
 * open. {@link postDigest} sends the rendered body as an ordinary `message`
 * to `@team` with `meta.digest = { day }`, which is the key lane 5 pins in
 * the Stream. `day` and `nightStart` are the scheduler's — the team's local
 * date and the night boundary in the effective working-hours schedule
 * (ADRs 206/494) — so this module never guesses a timezone.
 */

export interface DigestLearned {
  id: string;
  headline: string;
  body: string;
  ts: number;
}

export interface DigestUnanswered {
  id: string;
  from: string;
  to: string | null;
  thread: string | null;
  age_ms: number;
}

export interface Digest {
  /** The team's local date, `YYYY-MM-DD` — also the `meta.digest.day` key. */
  day: string;
  nightStart: number;
  learned: DigestLearned[];
  waiting: WaitingOnEntry[];
  unanswered: DigestUnanswered[];
}

export interface BuildDigestOpts {
  day: string;
  nightStart: number;
  now?: number;
}

function headlineOf(body: string, meta: string | null): string {
  try {
    const headline = meta ? (JSON.parse(meta) as { headline?: unknown }).headline : undefined;
    if (typeof headline === 'string' && headline.trim().length > 0) return headline.trim();
  } catch {
    // A malformed meta never breaks the digest — fall through to the body.
  }
  const first = body.split('\n', 1)[0] ?? '';
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

/**
 * Build the digest for one morning: insights saved since `nightStart`
 * (the night's `learned`), the current waiting-on per seat, and every ask
 * with neither an accept/decline naming it nor a resolve on its thread (the
 * same two shapes the discharge ledger uses).
 *
 * The night boundary and all ages walk the receipt clock (`created_at`), never
 * the envelope's `ts` — `ts` is the origin's clock and travels (ADR 335), so a
 * sender-skewed stamp must not push an insight out of, or an ask further into,
 * the night this daemon received it in.
 */
export async function buildDigest(
  db: Driver,
  teamId: string,
  opts: BuildDigestOpts,
): Promise<Digest> {
  const now = opts.now ?? Date.now();
  const learnedRows = await db.all<{ id: string; body: string; meta: string | null; ts: number }>(
    `SELECT id, body, meta, ts FROM messages
      WHERE team_id = ? AND act = 'insight' AND created_at >= ?
      ORDER BY ts ASC`,
    [teamId, opts.nightStart],
  );
  const unansweredRows = await db.all<{
    id: string;
    from_name: string;
    to_name: string | null;
    thread_id: string | null;
    received_at: number;
  }>(
    `SELECT m.id AS id, mf.name AS from_name, mt.name AS to_name, m.thread_id AS thread_id, m.created_at AS received_at
        FROM messages m
        JOIN members mf ON mf.id = m.from_member
        LEFT JOIN members mt ON mt.id = m.to_member
       WHERE m.team_id = ? AND m.act = 'ask'
         AND NOT EXISTS (${answeredByAnyoneSql('m')})
         AND NOT EXISTS (${resolvedThreadSql('m')})
       ORDER BY m.created_at ASC`,
    [teamId],
  );
  return {
    day: opts.day,
    nightStart: opts.nightStart,
    learned: learnedRows.map((r) => ({
      id: r.id,
      headline: headlineOf(r.body, r.meta),
      body: r.body,
      ts: r.ts,
    })),
    waiting: await waitingOn(db, teamId, now),
    unanswered: unansweredRows.map((r) => ({
      id: r.id,
      from: r.from_name,
      to: r.to_name,
      thread: r.thread_id,
      age_ms: Math.max(0, now - r.received_at),
    })),
  };
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24
    ? `${h}h${m % 60 === 0 ? '' : `${m % 60}m`}`
    : `${Math.floor(h / 24)}d${h % 24 === 0 ? '' : `${h % 24}h`}`;
}

/** Render the digest as a morning post: three glance lines per section, full rows beneath. */
export function renderDigestMarkdown(digest: Digest): {
  body: string;
  meta: { digest: { day: string } };
} {
  const lines = [`# Overnight — ${digest.day}`, ''];
  lines.push('## Learned');
  if (digest.learned.length === 0) lines.push('- Nothing saved overnight.');
  for (const l of digest.learned) lines.push(`- ${l.headline}`);
  lines.push('', '## Waiting');
  if (digest.waiting.length === 0) lines.push('- Nobody is waiting on anyone.');
  for (const w of digest.waiting)
    lines.push(
      `- ${w.member}: ${w.threads} open thread${w.threads === 1 ? '' : 's'}, oldest ${ago(w.oldest_age_ms)}`,
    );
  lines.push('', '## Unanswered asks');
  if (digest.unanswered.length === 0) lines.push('- Every ask got an answer.');
  for (const u of digest.unanswered)
    lines.push(`- ${u.from}${u.to ? ` → ${u.to}` : ''} (${ago(u.age_ms)} old)`);
  return { body: `${lines.join('\n')}\n`, meta: { digest: { day: digest.day } } };
}

export interface PostDigestOpts {
  day: string;
  nightStart: number;
  now?: number;
}

/**
 * Post the morning digest as an ordinary `message` to the team, with
 * `meta.digest = { day }` — the key lane 5 pins in the Stream (presence-only:
 * a digest that later gains fields still counts). `day` and `nightStart` are
 * the scheduler's: the team's local date and the night boundary in the
 * effective working-hours schedule (ADRs 206/494). Returns null when this
 * day's digest is already on the record, so a retried schedule posts once —
 * the Stream pins the newest same-day digest, but the record should hold one.
 */
export async function postDigest(
  db: Driver,
  team: { id: string; slug: string },
  from: { id: string; name: string },
  opts: PostDigestOpts,
): Promise<MessageRow | null> {
  const now = opts.now ?? Date.now();
  const existing = await db.get<{ id: string }>(
    `SELECT id FROM messages
      WHERE team_id = ? AND meta IS NOT NULL AND json_extract(meta, '$.digest.day') = ?
      LIMIT 1`,
    [team.id, opts.day],
  );
  if (existing) return null;
  const digest = await buildDigest(db, team.id, {
    day: opts.day,
    nightStart: opts.nightStart,
    now,
  });
  const { body, meta } = renderDigestMarkdown(digest);
  return insertMessage(
    db,
    team.id,
    from.id,
    null,
    makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: from.name,
      to: { kind: 'team' },
      act: 'message',
      body,
      meta,
      ts: now,
    }),
    { now },
  );
}
