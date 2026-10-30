import {
  AnswerProofSchema,
  AnswerSchema,
  answerLabel,
  composeAnswerLine,
  questionOf,
  type AnswerChannel,
  type Question,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';

/**
 * Question asks (ADR 773): a seat's question to a person, open until it is answered, withdrawn by a
 * `resolve` on its thread, or closed with its lane. The state is derived from the ledger plus the
 * `question_answers` row (v136), whose key on the question is what makes the first answer win.
 */
export type QuestionState = 'open' | 'answered' | 'withdrawn' | 'lane_closed';

export interface QuestionAnswerView {
  id: string;
  by: string;
  channel: AnswerChannel;
  verified: boolean;
  late: boolean;
  answered_at: number;
  delivered_at: number | null;
  undelivered: boolean;
}

export interface QuestionView {
  id: string;
  asker: string;
  /** The addressee's name, or null for a question to the team. */
  to: string | null;
  question: Question;
  state: QuestionState;
  asked_at: number;
  answer?: QuestionAnswerView;
}

interface QuestionRow {
  id: string;
  meta: string | null;
  ts: number;
  asker: string;
  to_name: string | null;
  resolve_meta: string | null;
  answer_id: string | null;
  answered_by: string | null;
  channel: string | null;
  verified: number | null;
  late: number | null;
  answered_at: number | null;
  delivered_at: number | null;
  undelivered_at: number | null;
  lane_state: string | null;
}

const QUESTIONS_SQL = `SELECT m.id, m.meta, m.ts, f.name AS asker, t.name AS to_name,
    (SELECT COALESCE(r.meta, '{}') FROM messages r WHERE r.team_id = m.team_id AND r.act = 'resolve'
       AND r.thread_id = m.id ORDER BY r.ts, r.id LIMIT 1) AS resolve_meta,
    qa.answer_id, qa.answered_by, qa.channel, qa.verified, qa.late, qa.answered_at,
    qa.delivered_at, qa.undelivered_at,
    (SELECT l.state FROM lanes l WHERE l.team_id = m.team_id
       AND l.id = json_extract(m.meta, '$.question.context.lane')) AS lane_state
  FROM messages m
  JOIN members f ON f.id = m.from_member
  LEFT JOIN members t ON t.id = m.to_member
  LEFT JOIN question_answers qa ON qa.team_id = m.team_id AND qa.question_id = m.id
  WHERE m.team_id = ? AND m.act = 'ask' AND json_extract(m.meta, '$.question') IS NOT NULL`;

function toView(row: QuestionRow): QuestionView | null {
  const meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null;
  const question = questionOf(meta);
  if (!question) return null;
  // A late answer (one after the close) leaves the close standing; an on-time one is the close.
  const resolveMeta = row.resolve_meta
    ? (JSON.parse(row.resolve_meta) as Record<string, unknown> | null)
    : null;
  // A closed lane closes its questions on read (ADR 773 Consequences, 2026-10-30): every close path
  // (verdict, resolve, sweep, fold) is covered without each one having to write a resolve.
  const laneClosed = row.lane_state === 'done' || row.lane_state === 'abandoned';
  const state: QuestionState =
    row.answer_id !== null && row.late !== 1
      ? 'answered'
      : laneClosed || resolveMeta?.['withdrawn'] === 'lane_closed'
        ? 'lane_closed'
        : row.resolve_meta === null
          ? 'open'
          : 'withdrawn';
  return {
    id: row.id,
    asker: row.asker,
    to: row.to_name,
    question,
    state,
    asked_at: row.ts,
    ...(row.answer_id !== null
      ? {
          answer: {
            id: row.answer_id,
            by: row.answered_by ?? '',
            channel: (row.channel ?? 'live') as AnswerChannel,
            verified: row.verified === 1,
            late: row.late === 1,
            answered_at: row.answered_at ?? 0,
            delivered_at: row.delivered_at,
            undelivered: row.undelivered_at !== null,
          },
        }
      : {}),
  };
}

export async function questionView(
  db: Driver,
  teamId: string,
  questionId: string,
): Promise<QuestionView | null> {
  const row = await db.get<QuestionRow>(`${QUESTIONS_SQL} AND m.id = ?`, [teamId, questionId]);
  return row ? toView(row) : null;
}

/** Every question on the team, oldest first. */
async function allQuestions(db: Driver, teamId: string): Promise<QuestionView[]> {
  const rows = await db.all<QuestionRow>(`${QUESTIONS_SQL} ORDER BY m.ts, m.id`, [teamId]);
  return rows.map(toView).filter((v): v is QuestionView => v !== null);
}

/** True when `person` may answer this question (ADR 773 §2 `audience`). */
export function mayAnswer(
  view: Pick<QuestionView, 'to' | 'asker' | 'question'>,
  person: string,
): boolean {
  if (person === view.asker) return false;
  return view.to === person || view.question.audience === 'team';
}

/** Open questions, oldest first — with `forPerson`, only those that person may answer. */
export async function openQuestions(
  db: Driver,
  teamId: string,
  opts: { forPerson?: string } = {},
): Promise<QuestionView[]> {
  const open = (await allQuestions(db, teamId)).filter((q) => q.state === 'open');
  const person = opts.forPerson;
  return person === undefined ? open : open.filter((q) => mayAnswer(q, person));
}

/** Seats with an open question they asked — `waiting`, not idle (ADR 773 §9). */
export async function waitingSeats(db: Driver, teamId: string): Promise<Set<string>> {
  return new Set((await openQuestions(db, teamId)).map((q) => q.asker));
}

/** A claim with no persisted answer behind it after this long is an orphan (a send that failed
 *  between claim and persist). Long enough that an in-flight first answer is never overtaken. */
export const ORPHAN_CLAIM_MS = 60_000;

/**
 * Claim the question for this answer — the first answer wins (ADR 773 §3). `ON CONFLICT DO
 * NOTHING` plus a read-back keeps it one statement on both drivers; a loser learns who won.
 */
export async function claimAnswer(
  db: Driver,
  teamId: string,
  a: {
    questionId: string;
    answerId: string;
    asker: string;
    by: string;
    channel: AnswerChannel;
    verified: boolean;
    late: boolean;
    at: number;
  },
): Promise<{ ok: true } | { ok: false; by: string; channel: AnswerChannel }> {
  const res = await db.run(
    `INSERT INTO question_answers
       (team_id, question_id, answer_id, asker, answered_by, channel, verified, late, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (team_id, question_id) DO NOTHING`,
    [
      teamId,
      a.questionId,
      a.answerId,
      a.asker,
      a.by,
      a.channel,
      a.verified ? 1 : 0,
      a.late ? 1 : 0,
      a.at,
    ],
  );
  if (res.changes === 1) return { ok: true };
  // A claim whose answer never persisted (the send failed after the claim) must not hold the
  // question forever. Past the grace window with no message behind it, the claim is taken over.
  const taken = await db.run(
    `UPDATE question_answers SET answer_id = ?, asker = ?, answered_by = ?, channel = ?,
         verified = ?, late = ?, answered_at = ?
       WHERE team_id = ? AND question_id = ? AND answered_at < ?
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = question_answers.answer_id)`,
    [
      a.answerId,
      a.asker,
      a.by,
      a.channel,
      a.verified ? 1 : 0,
      a.late ? 1 : 0,
      a.at,
      teamId,
      a.questionId,
      a.at - ORPHAN_CLAIM_MS,
    ],
  );
  if (taken.changes === 1) return { ok: true };
  const won = await db.get<{ answered_by: string; channel: AnswerChannel }>(
    'SELECT answered_by, channel FROM question_answers WHERE team_id = ? AND question_id = ?',
    [teamId, a.questionId],
  );
  return { ok: false, by: won?.answered_by ?? '', channel: won?.channel ?? 'live' };
}

/**
 * The answer line for `seat` (ADR 774), or null when this act may not carry one: it is not a
 * question's answer, the answer is not verified, or `seat` did not ask the question. A null caller
 * falls back to the ids-only line. `recap` quotes the seat its own question first, for a fresh
 * session that could not resume.
 */
export async function answerLineFor(
  db: Driver,
  teamId: string,
  teamSlug: string,
  seat: string,
  answerId: string,
  opts: { recap?: boolean } = {},
): Promise<string | null> {
  const row = await db.get<{ act: string; meta: string | null }>(
    'SELECT act, meta FROM messages WHERE team_id = ? AND id = ?',
    [teamId, answerId],
  );
  if (!row || row.act !== 'accept' || !row.meta) return null;
  const meta = JSON.parse(row.meta) as Record<string, unknown>;
  const proof = AnswerProofSchema.safeParse(meta['answer_proof']);
  const answer = AnswerSchema.safeParse(meta['answer']);
  const questionId = meta['in_reply_to'];
  if (!proof.success || !proof.data.verified || !answer.success) return null;
  if (typeof questionId !== 'string') return null;
  const view = await questionView(db, teamId, questionId);
  if (!view || view.asker !== seat) return null;
  return composeAnswerLine({
    team: teamSlug,
    person: proof.data.by,
    questionId,
    answerId,
    channel: proof.data.channel,
    answer: answerLabel(view.question, answer.data),
    ...(opts.recap ? { recapOf: view.question.text } : {}),
  });
}

/** An answer not delivered by now is flagged on every card that shows it (ADR 773 §8). */
export const ANSWER_UNDELIVERED_MS = 5 * 60_000;

/**
 * Record that `seat` received answer `answerId` — by an injected doorbell line or a wake that
 * occupied. A no-op for any act that is not an undelivered answer to a question `seat` asked, so the
 * report handlers can call it for every act they see.
 */
export async function markAnswerDelivered(
  db: Driver,
  teamId: string,
  answerId: string,
  seat: string,
  via: 'inject' | 'wake',
  now: number = Date.now(),
): Promise<boolean> {
  const row = await db.get<{ question_id: string; answered_at: number; channel: string }>(
    `SELECT question_id, answered_at, channel FROM question_answers
      WHERE team_id = ? AND answer_id = ? AND asker = ? AND delivered_at IS NULL`,
    [teamId, answerId, seat],
  );
  if (!row) return false;
  await db.run(
    `UPDATE question_answers SET delivered_at = ?, delivered_via = ?
      WHERE team_id = ? AND answer_id = ? AND delivered_at IS NULL`,
    [now, via, teamId, answerId],
  );
  await appendAudit(db, teamId, {
    actor: null,
    action: 'question.answer_delivered',
    target: row.question_id,
    result: 'allow',
    detail: {
      answer: answerId,
      seat,
      via,
      channel: row.channel,
      latency_ms: now - row.answered_at,
    },
  });
  return true;
}

/**
 * Flag answers still undelivered past {@link ANSWER_UNDELIVERED_MS}. Re-offering is the rails' own
 * job — the idle seam re-raises an act until the seat reads past it, and the immediate lane re-leases
 * it — so the daemon's part is never letting a miss go silent.
 */
export async function sweepUndeliveredAnswers(
  db: Driver,
  teamId: string,
  now: number = Date.now(),
): Promise<string[]> {
  const rows = await db.all<{ question_id: string; answer_id: string; asker: string }>(
    `SELECT question_id, answer_id, asker FROM question_answers
      WHERE team_id = ? AND delivered_at IS NULL AND undelivered_at IS NULL AND answered_at < ?`,
    [teamId, now - ANSWER_UNDELIVERED_MS],
  );
  for (const r of rows) {
    await db.run(
      'UPDATE question_answers SET undelivered_at = ? WHERE team_id = ? AND question_id = ?',
      [now, teamId, r.question_id],
    );
    await appendAudit(db, teamId, {
      actor: null,
      action: 'question.answer_undelivered',
      target: r.question_id,
      result: 'deny',
      detail: { answer: r.answer_id, seat: r.asker },
    });
  }
  return rows.map((r) => r.answer_id);
}

export interface QuestionMeasures {
  asked: number;
  answered: number;
  /** Answered from a card (`/live`, the phone, Slack) rather than a terminal. */
  answered_off_terminal: number;
  inferred: number;
  delivered: number;
  undelivered: number;
  /** Undelivered answers with no flag — the design's zero target (ADR 773 Experiment). */
  unflagged_undelivered: number;
  /** Median answer → delivery, ms; null with nothing delivered. */
  resume_p50_ms: number | null;
}

/** The ADR 773 measures since `since` (ms epoch), for `team_report`. */
export async function questionMeasures(
  db: Driver,
  teamId: string,
  since: number,
  now: number = Date.now(),
): Promise<QuestionMeasures> {
  const asked = await db.all<{ meta: string | null }>(
    `SELECT meta FROM messages WHERE team_id = ? AND act = 'ask' AND ts >= ?
       AND json_extract(meta, '$.question') IS NOT NULL`,
    [teamId, since],
  );
  const answers = await db.all<{
    channel: string;
    answered_at: number;
    delivered_at: number | null;
    undelivered_at: number | null;
  }>(
    `SELECT channel, answered_at, delivered_at, undelivered_at FROM question_answers
      WHERE team_id = ? AND answered_at >= ?`,
    [teamId, since],
  );
  const latencies = answers
    .filter((a) => a.delivered_at !== null)
    .map((a) => a.delivered_at! - a.answered_at)
    .sort((x, y) => x - y);
  const late = (a: (typeof answers)[number]) =>
    a.delivered_at === null && now - a.answered_at >= ANSWER_UNDELIVERED_MS;
  return {
    asked: asked.length,
    answered: answers.length,
    answered_off_terminal: answers.filter((a) => a.channel !== 'cli').length,
    inferred: asked.filter((r) => questionOf(r.meta ? JSON.parse(r.meta) : null)?.inferred).length,
    delivered: latencies.length,
    undelivered: answers.filter(late).length,
    unflagged_undelivered: answers.filter((a) => late(a) && a.undelivered_at === null).length,
    resume_p50_ms: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)]! : null,
  };
}
