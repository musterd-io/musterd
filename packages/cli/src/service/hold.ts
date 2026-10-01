/**
 * The auto-refresher's time-boxed hold (lane 01M3TE3VN1) — `musterd service hold --auto`. A demo or
 * pitch must not have the daemon bounce under it, and the only freeze used to be `launchctl bootout`
 * of the refresher's LaunchAgent, which someone then had to remember to undo. A hold is a stamp the
 * tick honours until a time and then clears itself, so a forgotten freeze cannot pin the daemon.
 * Pure: the command owns the file, the tick owns the decision, this owns the arithmetic.
 */

/** The longest hold allowed: a demo slot plus margin, never a week-long typo. */
export const MAX_HOLD_MS = 12 * 3600_000;

/** `2h`, `90m`, `1h30m` → ms; anything else (including zero) → null. */
export function parseDuration(s: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(s.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const ms = Number(m[1] ?? 0) * 3600_000 + Number(m[2] ?? 0) * 60_000;
  return ms > 0 ? ms : null;
}

/** The expiry (epoch ms) for `--until HH:MM` (today, or tomorrow once that time has passed) or
 *  `--for <duration>`. Throws a message fit for the operator on anything malformed or over the cap. */
export function resolveHoldUntil(o: { until?: string; for?: string; now: Date }): number {
  if (o.until !== undefined && o.for !== undefined)
    throw new Error('give --until or --for, not both');
  let until: number;
  if (o.until !== undefined) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(o.until.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59)
      throw new Error(`--until wants a 24h local time HH:MM (got "${o.until}")`);
    const d = new Date(o.now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= o.now.getTime()) d.setDate(d.getDate() + 1);
    until = d.getTime();
  } else if (o.for !== undefined) {
    const ms = parseDuration(o.for);
    if (ms === null)
      throw new Error(`--for wants a duration like 2h, 90m or 1h30m (got "${o.for}")`);
    until = o.now.getTime() + ms;
  } else {
    throw new Error('say how long: --until or --for (HH:MM, or a duration like 2h)');
  }
  if (until - o.now.getTime() > MAX_HOLD_MS)
    throw new Error(`a hold is capped at 12h — that would run until ${clock(until)}`);
  return until;
}

export type Hold = { state: 'none' } | { state: 'held' | 'expired'; until: number };

/** Read the stamp's raw contents against now. Unreadable reads as no hold — never as a freeze. */
export function readHold(raw: string | null, nowMs: number): Hold {
  const until = raw === null ? NaN : Number(raw.trim());
  if (!Number.isFinite(until) || until <= 0) return { state: 'none' };
  return { state: until > nowMs ? 'held' : 'expired', until };
}

/** `until 21:30 (1h12m left)` — the line the tick logs and `status` prints. */
export function describeHold(until: number, nowMs: number): string {
  const left = Math.max(0, Math.ceil((until - nowMs) / 60_000));
  const h = Math.floor(left / 60);
  return `until ${clock(until)} (${h > 0 ? `${h}h` : ''}${left % 60 || h === 0 ? `${left % 60}m` : ''} left)`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
