/** How full a window is, as a whole percent from 0 to 100. Over the limit stays at 100. */
export function fillPercent(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** A window is low when less than 15% remains, or the use has passed the limit. */
export function isLow(used: number, limit: number): boolean {
  if (limit <= 0) return used > 0;
  return used / limit >= 0.85;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const COUNT = new Intl.NumberFormat('en-US');

export function formatCount(n: number): string {
  return COUNT.format(n);
}

function unitWord(n: number, unit: string): string {
  if (Math.abs(n) !== 1) return unit;
  if (unit === 'characters') return 'character';
  if (unit === 'voice slots') return 'voice slot';
  return unit;
}

function ymd(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map((part) => Number(part));
  const next = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (date ?? 1) + days));
  return next.toISOString().slice(0, 10);
}

/** When a window comes back, in the reader's zone. */
export function formatWhen(ms: number, now: number, timeZone: string): string {
  if (ms <= now) return 'the reset time has passed';
  const day = ymd(ms, timeZone);
  const today = ymd(now, timeZone);
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(ms);
  if (day === today) return `today at ${clock}`;
  if (day === addDays(today, 1)) return `tomorrow at ${clock}`;
  if (day > today && day <= addDays(today, 6)) {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(ms);
    return `${weekday} at ${clock}`;
  }
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
    day: 'numeric',
  }).format(ms);
  return date;
}

/** The one sentence a window is allowed to say. */
export function windowSentence(
  used: number,
  limit: number,
  unit: string,
  resetsAt: number | null,
  now: number,
  timeZone: string,
  label?: string,
): string {
  const left = limit - used;
  const back = resetsAt == null ? '' : ` Back ${formatWhen(resetsAt, now, timeZone)}.`;
  if (label !== undefined && label !== '') {
    if (left < 0) return `${formatCount(Math.round(-left))}% over the ${label}.${back}`;
    if (Math.round(left) === 0) return `None left of the ${label}.${back}`;
    return `${formatCount(Math.round(left))}% left of the ${label}.${back}`;
  }
  if (unit === 'dollars') {
    const leftCents = Math.round(left * 100);
    const word = Math.abs(leftCents) === 100 ? 'dollar' : 'dollars';
    if (leftCents < 0) {
      return `${formatCount(-leftCents / 100)} ${word} of on-demand over ${formatCount(limit)}.${back}`;
    }
    if (leftCents === 0) return `None left of ${formatCount(limit)} dollars of on-demand.${back}`;
    return `${formatCount(leftCents / 100)} ${word} of on-demand left of ${formatCount(limit)}.${back}`;
  }
  if (left < 0) {
    return `${formatCount(-left)} ${unitWord(left, unit)} over ${formatCount(limit)}.${back}`;
  }
  if (left === 0) {
    return `None left of ${formatCount(limit)} ${unit}.${back}`;
  }
  return `${formatCount(left)} ${unitWord(left, unit)} left of ${formatCount(limit)}.${back}`;
}

export function readAtSentence(ms: number, timeZone: string): string {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(ms);
  return `Read at ${clock}.`;
}
