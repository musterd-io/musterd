/**
 * ADR 792: the one shift line every surface prints — `/live`, `musterd status`, `musterd residency
 * status`, `team_status`. Plain TypeScript, no zod, so `/live` reads it from the wire bundle.
 * `timezone` formats `until`; pass the seat's schedule timezone, or the viewer's own.
 */
export interface ShiftLineInput {
  state: 'on' | 'off' | 'ending';
  until: number | null;
  budget_left_usd: number;
  stop_reason: 'hours_end' | 'budget' | 'no_work' | 'stopped' | null;
}

const REASON_WORDS: Record<NonNullable<ShiftLineInput['stop_reason']>, string> = {
  hours_end: 'hours ended',
  budget: 'budget spent',
  no_work: 'no work left',
  stopped: 'stopped',
};

export function shiftLabel(shift: ShiftLineInput, timezone?: string): string {
  const money = `$${shift.budget_left_usd.toFixed(2)} left`;
  if (shift.state === 'on') {
    const until =
      shift.until === null
        ? ''
        : ` until ${new Intl.DateTimeFormat('en-GB', {
            ...(timezone ? { timeZone: timezone } : {}),
            hour: '2-digit',
            minute: '2-digit',
          }).format(shift.until)}`;
    return `on shift${until} · ${money}`;
  }
  const why = shift.stop_reason ? REASON_WORDS[shift.stop_reason] : 'off';
  return shift.state === 'ending' ? `ending shift (${why})` : `off shift (${why})`;
}
