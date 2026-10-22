import { STATUS_LINE_TTL_MS, type StatusLine, StatusLineTextSchema } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { appendReplicatedEvent } from './audit.js';
import type { MemberRow } from './rows.js';

/**
 * ADR 721: a human's own status line. The store refuses anything but a human (agents never have
 * one) and anything over 48 characters; who may call it — only that human, signed in as themselves —
 * is the route's check. Setting again starts a new hour. Expiry is read-time (`toMember`).
 */
export async function setStatusLine(
  db: Driver,
  member: MemberRow,
  text: string,
  now: number = Date.now(),
): Promise<StatusLine> {
  if (member.kind !== 'human') throw new Error('status lines are for humans only');
  const parsed = StatusLineTextSchema.safeParse(text);
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? 'a status line is at most 48 characters');
  const line: StatusLine = { text: parsed.data, set_at: now, expires_at: now + STATUS_LINE_TTL_MS };
  await db.run('UPDATE members SET status_line = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(line),
    now,
    member.id,
  ]);
  return line;
}

/**
 * The status line as a team that spans machines writes it (ADR 721 Decision 5): the row, plus a
 * replicated `status_line` event every other node folds — the `style.prefs` pattern. Only the hub, or
 * a daemon with no hub, calls this; a joiner forwards. `text: null` clears. The event carries the
 * text because it IS the transport; the `member.status_line` audit row keeps only the length.
 */
export async function applyStatusLine(
  db: Driver,
  teamId: string,
  member: MemberRow,
  text: string | null,
  now: number = Date.now(),
): Promise<StatusLine | null> {
  let line: StatusLine | null = null;
  try {
    await db.tx(async (t) => {
      if (text === null) await clearStatusLine(t, member, now);
      else line = await setStatusLine(t, member, text, now);
      await appendReplicatedEvent(t, teamId, {
        actor: member.name,
        action: 'status_line',
        target: null,
        result: 'allow',
        detail: { line },
      });
    });
  } catch (err) {
    if (err instanceof Error && /humans|characters|words/.test(err.message)) throw err;
    log.warn({ msg: 'status_line_stamp_failed', actor: member.name, err: String(err) });
    if (text === null) await clearStatusLine(db, member, now);
    else line = await setStatusLine(db, member, text, now);
  }
  return line;
}

export async function clearStatusLine(
  db: Driver,
  member: MemberRow,
  now: number = Date.now(),
): Promise<void> {
  await db.run('UPDATE members SET status_line = NULL, updated_at = ? WHERE id = ?', [
    now,
    member.id,
  ]);
}
