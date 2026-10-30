import { questionOf, type AnswerChannel, type Question } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';

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
}

const QUESTIONS_SQL = `SELECT m.id, m.meta, m.ts, f.name AS asker, t.name AS to_name,
    (SELECT COALESCE(r.meta, '{}') FROM messages r WHERE r.team_id = m.team_id AND r.act = 'resolve'
       AND r.thread_id = m.id ORDER BY r.ts, r.id LIMIT 1) AS resolve_meta,
    qa.answer_id, qa.answered_by, qa.channel, qa.verified, qa.late, qa.answered_at,
    qa.delivered_at, qa.undelivered_at
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
  const state: QuestionState =
    row.answer_id !== null && row.late !== 1
      ? 'answered'
      : row.resolve_meta === null
        ? 'open'
        : resolveMeta?.['withdrawn'] === 'lane_closed'
          ? 'lane_closed'
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
  const won = await db.get<{ answered_by: string; channel: AnswerChannel }>(
    'SELECT answered_by, channel FROM question_answers WHERE team_id = ? AND question_id = ?',
    [teamId, a.questionId],
  );
  return { ok: false, by: won?.answered_by ?? '', channel: won?.channel ?? 'live' };
}
