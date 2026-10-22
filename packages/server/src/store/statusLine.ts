import { STATUS_LINE_TTL_MS, type StatusLine, StatusLineTextSchema } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import type { MemberRow } from './rows.js';

/**
 * ADR 721: a human's own status line. The store refuses anything but a human (agents never have
 * one) and anything over 48 characters; who may call it — only that human, signed in as themselves —
 * is the route's check. Setting again starts a new hour. Expiry is read-time (`toMember`).
 */
export async function setStatusLine(db: Driver, member: MemberRow, text: string, now: number = Date.now()): Promise<StatusLine> {
  if (member.kind !== 'human') throw new Error('status lines are for humans only');
  const parsed = StatusLineTextSchema.safeParse(text);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'a status line is at most 48 characters');
  const line: StatusLine = { text: parsed.data, set_at: now, expires_at: now + STATUS_LINE_TTL_MS };
  await db.run('UPDATE members SET status_line = ?, updated_at = ? WHERE id = ?', [JSON.stringify(line), now, member.id]);
  return line;
}

export async function clearStatusLine(db: Driver, member: MemberRow, now: number = Date.now()): Promise<void> {
  await db.run('UPDATE members SET status_line = NULL, updated_at = ? WHERE id = ?', [now, member.id]);
}
