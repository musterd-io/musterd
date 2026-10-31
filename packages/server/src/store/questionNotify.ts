import {
  isWithinWorkingHours,
  notifyDecision,
  QuestionNotifyPrefsSchema,
  type QuestionNotifyPrefs,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';
import { getMemberById } from './members.js';
import { parseWorkingHours } from './rows.js';
import { getTeamById } from './teams.js';

/**
 * A person's question-notification preferences (ADR 779 §5, v138): per channel buzz/quiet and per
 * seat always/never, beside the channel settings that already decide which channels deliver at
 * all. No row is the defaults. Quiet hours are the person's own working hours (the team's when
 * they have none) — no second schedule to keep in step.
 */
export async function getQuestionNotify(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<QuestionNotifyPrefs> {
  const row = await db.get<{ prefs_json: string }>(
    'SELECT prefs_json FROM member_question_notify WHERE team_id = ? AND member_id = ?',
    [teamId, memberId],
  );
  if (!row) return {};
  const parsed = QuestionNotifyPrefsSchema.safeParse(JSON.parse(row.prefs_json));
  return parsed.success ? parsed.data : {};
}

export async function setQuestionNotify(
  db: Driver,
  teamId: string,
  member: { id: string; name: string },
  prefs: QuestionNotifyPrefs,
  now: number = Date.now(),
): Promise<QuestionNotifyPrefs> {
  const clean = QuestionNotifyPrefsSchema.parse(prefs);
  await db.run(
    `INSERT INTO member_question_notify (team_id, member_id, prefs_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (team_id, member_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`,
    [teamId, member.id, JSON.stringify(clean), now],
  );
  await appendAudit(db, teamId, {
    actor: member.name,
    action: 'question.notify_set',
    target: member.name,
    result: 'allow',
    detail: {
      channels: Object.keys(clean.channels ?? {}).length,
      seats: Object.keys(clean.seats ?? {}).length,
    },
  });
  return clean;
}

/** True outside the person's working hours (or the team's); false when neither has any. */
export async function inQuietHours(
  db: Driver,
  teamId: string,
  memberId: string,
  now: number,
): Promise<boolean> {
  const member = await getMemberById(db, memberId);
  const hours =
    parseWorkingHours(member?.working_hours) ??
    parseWorkingHours((await getTeamById(db, teamId))?.working_hours);
  return hours ? !isWithinWorkingHours(hours, now) : false;
}

/** The one decision a delivery path asks: does this question buzz this person on this channel? */
export async function questionBuzzes(
  db: Driver,
  teamId: string,
  memberId: string,
  ctx: { channel: string; seat: string; blocking: boolean; activeOnLive: boolean },
  now: number = Date.now(),
): Promise<boolean> {
  const prefs = await getQuestionNotify(db, teamId, memberId);
  const quiet = await inQuietHours(db, teamId, memberId, now);
  return notifyDecision(prefs, { ...ctx, inQuietHours: quiet }) === 'buzz';
}
