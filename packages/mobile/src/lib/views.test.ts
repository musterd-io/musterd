import type { CalendarEntry } from '@musterd/protocol/calendar';
import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  clock12,
  dayHeading,
  happeningNow,
  isOver,
  monthGrid,
  pastSections,
  rowLines,
  shiftMonth,
  timeLabel,
  upcomingSections,
  upNext,
  wallClock,
  zoneNote,
} from './views';

let n = 0;
function entry(over: Partial<CalendarEntry>): CalendarEntry {
  n++;
  return {
    id: `e${n}`,
    title: `entry ${n}`,
    date: '2026-10-06',
    start: null,
    end: null,
    tz: 'America/Los_Angeles',
    kind: 'event',
    status: null,
    place: '',
    url: null,
    note: '',
    pick: false,
    source: '',
    source_ref: null,
    created_by: 'nick',
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

// 2026-10-06 12:00 in Los Angeles (PDT, UTC-7).
const noonLA = new Date(Date.UTC(2026, 9, 6, 19, 0));

describe('wallClock', () => {
  it('projects an instant into the entry zone, not the device zone', () => {
    expect(wallClock('America/Los_Angeles', noonLA)).toEqual({ date: '2026-10-06', time: '12:00' });
    expect(wallClock('Europe/London', noonLA)).toEqual({ date: '2026-10-06', time: '20:00' });
    expect(wallClock('Asia/Tokyo', noonLA)).toEqual({ date: '2026-10-07', time: '04:00' });
  });
});

describe('isOver', () => {
  it('keeps an all-day entry for its whole day', () => {
    expect(isOver(entry({ date: '2026-10-06' }), noonLA)).toBe(false);
    expect(isOver(entry({ date: '2026-10-05' }), noonLA)).toBe(true);
  });
  it('ends a timed entry at its end, and an open-ended one an hour after it starts', () => {
    expect(isOver(entry({ start: '11:00', end: '12:30' }), noonLA)).toBe(false);
    expect(isOver(entry({ start: '10:00', end: '11:59' }), noonLA)).toBe(true);
    expect(isOver(entry({ start: '11:30' }), noonLA)).toBe(false);
    expect(isOver(entry({ start: '11:00' }), noonLA)).toBe(true);
  });
  it('reads the entry in its own zone', () => {
    // 10:00 in New York is 13:00 there at LA noon — over an hour ago.
    expect(isOver(entry({ start: '10:00', end: '11:00', tz: 'America/New_York' }), noonLA)).toBe(
      true,
    );
  });
});

describe('upNext', () => {
  it('is the first entry not over and not done, in calendar order', () => {
    const done = entry({ start: '13:00', status: 'done' });
    const past = entry({ start: '09:00', end: '10:00' });
    const later = entry({ date: '2026-10-07', start: '09:00' });
    const soon = entry({ start: '15:00' });
    expect(upNext([later, done, past, soon], noonLA)?.id).toBe(soon.id);
    expect(upNext([past], noonLA)).toBeNull();
  });
});

describe('applyFilter', () => {
  const a = entry({ kind: 'demo', pick: true });
  const b = entry({ kind: 'pitch' });
  it('Picks keeps picked entries; Everything keeps all', () => {
    expect(applyFilter([a, b], { scope: 'picks', kinds: [] })).toEqual([a]);
    expect(applyFilter([a, b], { scope: 'everything', kinds: [] })).toEqual([a, b]);
  });
  it('kind chips narrow; none selected means every kind', () => {
    expect(applyFilter([a, b], { scope: 'everything', kinds: ['pitch'] })).toEqual([b]);
  });
});

describe('sections', () => {
  const y = entry({ date: '2026-10-05', title: 'y' });
  const t1 = entry({ date: '2026-10-06', start: '09:00', title: 't1' });
  const t0 = entry({ date: '2026-10-06', title: 't0' });
  const w = entry({ date: '2026-10-08', title: 'w' });
  const old = entry({ date: '2026-09-01', title: 'old' });
  it('Upcoming is today onward, soonest first, all-day before timed', () => {
    const s = upcomingSections([w, t1, y, t0], '2026-10-06');
    expect(s.map((d) => d.date)).toEqual(['2026-10-06', '2026-10-08']);
    expect(s[0]!.entries.map((e) => e.title)).toEqual(['t0', 't1']);
  });
  it('Past is before today, most recent day first', () => {
    expect(pastSections([old, y, t0], '2026-10-06').map((d) => d.date)).toEqual([
      '2026-10-05',
      '2026-09-01',
    ]);
  });
});

describe('monthGrid', () => {
  it('lays October 2026 out Sunday-first (the 1st is a Thursday)', () => {
    const g = monthGrid(2026, 9);
    expect(g[0]).toEqual([null, null, null, null, '2026-10-01', '2026-10-02', '2026-10-03']);
    expect(g.flat().filter(Boolean)).toHaveLength(31);
    expect(g.every((w) => w.length === 7)).toBe(true);
  });
  it('steps across a year boundary', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month0: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month0: 11 });
  });
});

describe('labels', () => {
  it('names nearby days and dates the rest', () => {
    expect(dayHeading('2026-10-06', '2026-10-06')).toBe('Today');
    expect(dayHeading('2026-10-07', '2026-10-06')).toBe('Tomorrow');
    expect(dayHeading('2026-10-05', '2026-10-06')).toBe('Yesterday');
    expect(dayHeading('2026-10-12', '2026-10-06')).toBe('Mon 12 Oct');
    expect(dayHeading('2027-01-04', '2026-10-06')).toBe('Mon 4 Jan 2027');
  });
  it('writes times on a 12-hour clock', () => {
    expect(clock12('00:00')).toBe('12am');
    expect(clock12('12:00')).toBe('12pm');
    expect(clock12('14:30')).toBe('2:30pm');
    expect(timeLabel(entry({}))).toBe('All day');
    expect(timeLabel(entry({ start: '09:00', end: '10:15' }))).toBe('9am–10:15am');
  });
  it('says whose clock a time is on only when it is not the device zone', () => {
    expect(zoneNote(entry({}), 'America/Los_Angeles')).toBeNull();
    expect(zoneNote(entry({ tz: 'America/New_York' }), 'America/Los_Angeles')).toBe(
      'New York time',
    );
  });
});

describe('rowLines', () => {
  it('shows the place, the note and the link together', () => {
    expect(
      rowLines(
        entry({
          kind: 'demo',
          status: 'going',
          place: 'TERRA',
          note: ' bring QR ',
          url: 'https://www.lu.ma/x',
        }),
      ),
    ).toEqual({
      meta: 'demo · going',
      place: 'TERRA',
      note: 'bring QR',
      link: { label: 'lu.ma', url: 'https://www.lu.ma/x' },
    });
    expect(rowLines(entry({ kind: 'event' }))).toEqual({
      meta: 'event',
      place: null,
      note: null,
      link: null,
    });
  });
});

describe('up next and now', () => {
  // noonLA is 12:00 in Los Angeles.
  const conf = entry({ title: 'conf', start: '11:00', end: '19:00' });
  const prep = entry({ title: 'prep', kind: 'prep', start: '12:30' });
  const talk = entry({ title: 'talk', start: '13:00' });
  it('Up next is the next event to start, never a running one or a prep', () => {
    expect(upNext([conf, prep, talk], noonLA)?.title).toBe('talk');
  });
  it('Now lists timed events already running', () => {
    expect(happeningNow([conf, prep, talk], noonLA).map((e) => e.title)).toEqual(['conf']);
  });
});
