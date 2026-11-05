import {
  POLL_LIMITS,
  TOKEN_PREFIXES,
  winnersOf,
  type OpenPoll,
  type OpenPollReply,
  type PollCounts,
  type PollEnd,
  type PollMeta,
  type PollSpec,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { hashToken, newSecret } from './members.js';

/**
 * Twitch polls (ADR 807), held by the hub. A poll is a human admin's question with 2–4 options; the
 * stream machine reports integer counts on a one-poll `mspoll_` token, and its last word on whether
 * Twitch shows the channel live gates opening and closes a poll that has been offline for 90 s.
 */

interface PollRow {
  id: string;
  team_id: string;
  question: string;
  options_json: string;
  minutes: number;
  opened_by: string;
  opened_at: number;
  closes_at: number;
  counts_json: string;
  voters: number;
  post_failed: number;
  token_sha256: string;
  open_msg_id: string | null;
  end_reason: PollEnd | null;
  closed_at: number | null;
}

interface LivenessRow {
  live: number;
  reported_at: number;
  offline_since: number | null;
}

function toOpenPoll(r: PollRow): OpenPoll {
  return {
    id: r.id,
    question: r.question,
    options: JSON.parse(r.options_json) as string[],
    minutes: r.minutes,
    opened_by: r.opened_by,
    opened_at: Number(r.opened_at),
    closes_at: Number(r.closes_at),
    counts: JSON.parse(r.counts_json) as number[],
    voters: r.voters,
    post_failed: r.post_failed === 1,
  };
}

/** The `meta.poll` of the daemon's opening message. */
export function openMeta(p: OpenPoll): Extract<PollMeta, { state: 'open' }> {
  return {
    state: 'open',
    id: p.id,
    question: p.question,
    options: p.options,
    opened_by: p.opened_by,
    opened_at: p.opened_at,
    closes_at: p.closes_at,
  };
}

/** The stream machine says whether Twitch shows the channel live; an `offline` run keeps its start. */
export async function reportLive(
  db: Driver,
  teamId: string,
  live: boolean,
  now: number,
): Promise<void> {
  const prev = await db.get<LivenessRow>('SELECT * FROM stream_liveness WHERE team_id = ?', [
    teamId,
  ]);
  const offlineSince = live ? null : ((prev && prev.live === 0 ? prev.offline_since : null) ?? now);
  if (prev) {
    await db.run(
      'UPDATE stream_liveness SET live = ?, reported_at = ?, offline_since = ? WHERE team_id = ?',
      [live ? 1 : 0, now, offlineSince, teamId],
    );
  } else {
    await db.run(
      'INSERT INTO stream_liveness (team_id, live, reported_at, offline_since) VALUES (?, ?, ?, ?)',
      [teamId, live ? 1 : 0, now, offlineSince],
    );
  }
}

/** Twitch reported the channel live, and that report is inside the offline grace. */
export async function isLive(db: Driver, teamId: string, now: number): Promise<boolean> {
  const row = await db.get<LivenessRow>('SELECT * FROM stream_liveness WHERE team_id = ?', [
    teamId,
  ]);
  return !!row && row.live === 1 && now - Number(row.reported_at) < POLL_LIMITS.offlineGraceMs;
}

async function openRow(db: Driver, teamId: string): Promise<PollRow | undefined> {
  return db.get<PollRow>('SELECT * FROM polls WHERE team_id = ? AND end_reason IS NULL', [teamId]);
}

/** Open the team's poll. The caller has already checked the admin and the passkey (ADR 807 §2). */
export async function openPoll(
  db: Driver,
  teamId: string,
  by: string,
  spec: PollSpec,
  now: number,
): Promise<{ poll: OpenPoll; token: string }> {
  if (!(await isLive(db, teamId, now)))
    throw new MusterdError('conflict', 'the stream is not live on Twitch, so a poll cannot open');
  if (await openRow(db, teamId))
    throw new MusterdError('conflict', 'a poll is already open on this team');
  const id = ulid();
  const token = newSecret(TOKEN_PREFIXES.poll);
  try {
    await db.run(
      `INSERT INTO polls (id, team_id, question, options_json, minutes, opened_by, opened_at, closes_at,
         counts_json, voters, post_failed, token_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        id,
        teamId,
        spec.question.trim(),
        JSON.stringify(spec.options.map((o) => o.trim())),
        spec.minutes,
        by,
        now,
        now + spec.minutes * 60_000,
        JSON.stringify(spec.options.map(() => 0)),
        hashToken(token),
      ],
    );
  } catch {
    // The partial unique index: another open won the race.
    throw new MusterdError('conflict', 'a poll is already open on this team');
  }
  return { poll: toOpenPoll((await openRow(db, teamId))!), token };
}

/** Remember the opening message, so the close can resolve its thread. */
export async function setPollMessage(db: Driver, pollId: string, msgId: string): Promise<void> {
  await db.run('UPDATE polls SET open_msg_id = ? WHERE id = ?', [msgId, pollId]);
}

export async function pollMessage(db: Driver, pollId: string): Promise<string | null> {
  return (
    (
      await db.get<{ open_msg_id: string | null }>('SELECT open_msg_id FROM polls WHERE id = ?', [
        pollId,
      ])
    )?.open_msg_id ?? null
  );
}

/**
 * Mint the open poll's token afresh for the broadcast seat. Only the newest hash is kept, so a
 * restarted stream machine simply reads a new one; the old stops working (hard rule 5).
 */
export async function issuePollToken(db: Driver, teamId: string, pollId: string): Promise<string> {
  const token = newSecret(TOKEN_PREFIXES.poll);
  const r = await db.run(
    'UPDATE polls SET token_sha256 = ? WHERE id = ? AND team_id = ? AND end_reason IS NULL',
    [hashToken(token), pollId, teamId],
  );
  if (r.changes === 0) throw new MusterdError('not_found', 'no open poll with that id');
  return token;
}

/** `GET /polls/open`: the live flag and the open poll; its token only for the broadcast seat. */
export async function openPollReply(
  db: Driver,
  teamId: string,
  viewer: { broadcast: boolean },
  now: number,
): Promise<OpenPollReply> {
  const live = await isLive(db, teamId, now);
  const row = await openRow(db, teamId);
  if (!row) return { live, poll: null };
  const poll = toOpenPoll(row);
  if (viewer.broadcast) poll.poll_token = await issuePollToken(db, teamId, row.id);
  return { live, poll };
}

/** The stream machine's counts, on the poll's token. Integers only reach here (PollCountsSchema). */
export async function reportCounts(
  db: Driver,
  teamId: string,
  pollId: string,
  token: string,
  c: PollCounts,
  now: number,
): Promise<'ok' | 'closed' | 'bad_token' | 'bad_counts'> {
  const row = await db.get<PollRow>('SELECT * FROM polls WHERE id = ? AND team_id = ?', [
    pollId,
    teamId,
  ]);
  if (!row || c.poll_id !== pollId || row.token_sha256 !== hashToken(token)) return 'bad_token';
  if (row.end_reason !== null || now >= Number(row.closes_at)) return 'closed';
  const options = (JSON.parse(row.options_json) as string[]).length;
  const sum = c.counts.reduce((a, b) => a + b, 0);
  // One current vote per voter: no option can hold more than the voters, nor all of them together.
  if (c.counts.length !== options || sum > c.voters) return 'bad_counts';
  await db.run('UPDATE polls SET counts_json = ?, voters = ?, post_failed = ? WHERE id = ?', [
    JSON.stringify(c.counts),
    c.voters,
    c.post_failed ? 1 : 0,
    pollId,
  ]);
  await reportLive(db, teamId, c.live, now);
  return 'ok';
}

/** Close the poll and say how it went. Null when it is not open (already closed, or never was). */
export async function closePoll(
  db: Driver,
  teamId: string,
  pollId: string,
  end: PollEnd,
  now: number,
): Promise<Extract<PollMeta, { state: 'closed' }> | null> {
  const r = await db.run(
    'UPDATE polls SET end_reason = ?, closed_at = ? WHERE id = ? AND team_id = ? AND end_reason IS NULL',
    [end, now, pollId, teamId],
  );
  if (r.changes === 0) return null;
  const row = (await db.get<PollRow>('SELECT * FROM polls WHERE id = ?', [pollId]))!;
  const p = toOpenPoll(row);
  return {
    ...openMeta(p),
    state: 'closed',
    counts: p.counts,
    voters: p.voters,
    end,
    winners: end === 'cancelled' ? [] : winnersOf(p.counts),
    closed_at: now,
  };
}

/** The open polls that should close now: past their deadline, or their stream offline (or silent) 90 s. */
export async function duePolls(
  db: Driver,
  now: number,
): Promise<{ teamId: string; pollId: string; end: PollEnd }[]> {
  const rows = await db.all<
    PollRow & { live: number | null; reported_at: number | null; offline_since: number | null }
  >(
    `SELECT p.*, l.live AS live, l.reported_at AS reported_at, l.offline_since AS offline_since
       FROM polls p LEFT JOIN stream_liveness l ON l.team_id = p.team_id
      WHERE p.end_reason IS NULL`,
  );
  const due: { teamId: string; pollId: string; end: PollEnd }[] = [];
  for (const r of rows) {
    const grace = POLL_LIMITS.offlineGraceMs;
    const offline = r.offline_since !== null && now - Number(r.offline_since) >= grace;
    const silent = r.reported_at === null || now - Number(r.reported_at) >= grace;
    if (now >= Number(r.closes_at)) due.push({ teamId: r.team_id, pollId: r.id, end: 'deadline' });
    else if (offline || silent) due.push({ teamId: r.team_id, pollId: r.id, end: 'interrupted' });
  }
  return due;
}
