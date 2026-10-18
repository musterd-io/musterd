import type { LaneBoard } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  capEntries,
  experimentEntries,
  experimentsCount,
  READ_SHOWN_MS,
  shortTitle,
  stripDays,
  teamToday,
} from './experimentReads';

// Sat 2026-10-17, 15:00 in Los Angeles (22:00 UTC).
const NOW = Date.UTC(2026, 9, 17, 22, 0);

const lane = (id: string, over: Record<string, unknown>) => ({
  id,
  title: `Read ${id}`,
  owner_seat: 'stanley',
  state: 'claimed',
  ...over,
});
const board = (...lanes: object[]) => ({ lanes, warnings: [] }) as unknown as LaneBoard;

describe('experimentEntries', () => {
  it('shows only lanes carrying reads_on, and never a dropped one', () => {
    const got = experimentEntries(
      board(
        lane('a', {}),
        lane('b', { reads_on: '2026-10-20', read_status: 'waiting' }),
        lane('c', { reads_on: '2026-10-10', read_status: 'dropped' }),
      ),
      NOW,
    );
    expect(got.map((e) => e.id)).toEqual(['b']);
  });

  it('takes the status from the server, never from the date', () => {
    // A date in the past the server still calls waiting: the web does not overrule it.
    const [e] = experimentEntries(
      board(lane('a', { reads_on: '2026-10-10', read_status: 'waiting' })),
      NOW,
    );
    expect(e!.status).toBe('waiting');
    expect(e!.phrase).toBe('tomorrow');
  });

  it('orders overdue, due, waiting, read — each group by its own rule', () => {
    const got = experimentEntries(
      board(
        lane('w2', { reads_on: '2026-11-02', read_status: 'waiting' }),
        lane('r-old', {
          reads_on: '2026-10-12',
          read_status: 'read',
          read_verdict: { outcome: 'met', note: 'n', by: 'x', at: NOW - 3 * 86_400_000 },
        }),
        lane('w1', { reads_on: '2026-10-20', read_status: 'waiting' }),
        lane('o-new', { reads_on: '2026-10-16', read_status: 'overdue' }),
        lane('d', { title: 'B due', reads_on: '2026-10-17', read_status: 'due' }),
        lane('o-old', { reads_on: '2026-10-13', read_status: 'overdue' }),
        lane('r-new', {
          reads_on: '2026-10-14',
          read_status: 'read',
          read_verdict: { outcome: 'missed', note: 'n', by: 'x', at: NOW - 86_400_000 },
        }),
        lane('d2', { title: 'A due', reads_on: '2026-10-17', read_status: 'due' }),
      ),
      NOW,
    );
    expect(got.map((e) => e.id)).toEqual(['o-old', 'o-new', 'd2', 'd', 'w1', 'w2', 'r-new', 'r-old']);
  });

  it('keeps a read for seven days after its verdict, then lets it go', () => {
    const read = (at: number) =>
      lane('r', {
        reads_on: '2026-10-01',
        read_status: 'read',
        read_verdict: { outcome: 'inconclusive', note: 'n', by: 'x', at },
      });
    expect(experimentEntries(board(read(NOW - READ_SHOWN_MS)), NOW)).toHaveLength(1);
    expect(experimentEntries(board(read(NOW - READ_SHOWN_MS - 1)), NOW)).toHaveLength(0);
  });

  it('says the §5 phrases and the weekday date', () => {
    const got = experimentEntries(
      board(
        lane('o1', { reads_on: '2026-10-16', read_status: 'overdue' }),
        lane('o2', { reads_on: '2026-10-15', read_status: 'overdue' }),
        lane('d', { reads_on: '2026-10-17', read_status: 'due' }),
        lane('w1', { reads_on: '2026-10-18', read_status: 'waiting' }),
        lane('w16', { reads_on: '2026-11-02', read_status: 'waiting' }),
        lane('r', {
          reads_on: '2026-10-17',
          read_status: 'read',
          read_verdict: { outcome: 'met', note: 'beat it', by: 'x', at: NOW },
        }),
      ),
      NOW,
    );
    const by = Object.fromEntries(got.map((e) => [e.id, e]));
    expect(by.o1!.phrase).toBe('overdue · 1 day');
    expect(by.o2!.phrase).toBe('overdue · 2 days');
    expect(by.d!.phrase).toBe('due today');
    expect(by.w1!.phrase).toBe('tomorrow');
    expect(by.w16!.phrase).toBe('in 16 days');
    expect(by.w16!.date).toBe('Mon 11-02');
    expect(by.w16!.leaf).toEqual({ weekday: 'MON', day: 2, month: 'Nov' });
    expect(by.w16!.offset).toBe(16);
    expect(by.o2!.offset).toBe(-2);
    expect(by.r!.phrase).toBe('met');
    expect(by.r!.note).toBe('beat it');
    expect(by.d!.note).toBeNull();
    expect(by.w16!.label).toBe('Read w16, in 16 days, reads Monday, November 2, owner stanley');
  });

  it('counts days in the team zone, not UTC', () => {
    // 2026-10-18 03:00 UTC is still the 17th in Los Angeles.
    expect(teamToday(Date.UTC(2026, 9, 18, 3, 0))).toBe('2026-10-17');
  });

  it('is empty with no board', () => {
    expect(experimentEntries(null, NOW)).toEqual([]);
  });
});

describe('capEntries', () => {
  const entries = (statuses: string[]) =>
    experimentEntries(
      board(
        ...statuses.map((s, i) =>
          lane(`l${i}`, {
            reads_on: s === 'waiting' ? '2026-10-30' : s === 'due' ? '2026-10-17' : '2026-10-10',
            read_status: s,
          }),
        ),
      ),
      NOW,
    );

  it('shows five', () => {
    expect(capEntries(entries(Array(8).fill('waiting')))).toHaveLength(5);
  });

  it('never hides an urgent row', () => {
    const all = entries([...Array(6).fill('overdue'), 'due', 'waiting', 'waiting']);
    const shown = capEntries(all);
    expect(shown).toHaveLength(7);
    expect(shown.every((e) => e.status !== 'waiting')).toBe(true);
  });
});

describe('experimentsCount', () => {
  const e = (status: string) => ({ status }) as never;
  it('names only the urgent statuses above zero', () => {
    expect(experimentsCount([e('overdue'), e('due'), e('waiting')])).toBe('1 overdue · 1 due');
    expect(experimentsCount([e('due'), e('due')])).toBe('2 due');
  });
  it('falls back to reads when nothing is urgent', () => {
    expect(experimentsCount([e('waiting')])).toBe('1 read');
    expect(experimentsCount([e('waiting'), e('read'), e('read')])).toBe('3 reads');
  });
});

describe('shortTitle', () => {
  it('keeps the name, drops the repeated date and the instructions', () => {
    expect(shortTitle('ADR 536 14-day read (2026-10-20): run `pnpm next:readout`')).toBe('ADR 536 14-day read');
    expect(shortTitle('Dogfood the accountability claims: humans receive real handoffs')).toBe(
      'Dogfood the accountability claims',
    );
    expect(shortTitle('Wake rail — binding read')).toBe('Wake rail');
  });
  it('keeps the whole title when the cut would leave almost nothing', () => {
    expect(shortTitle('Inc 2: the pins')).toBe('Inc 2: the pins');
    expect(shortTitle('a plain title')).toBe('a plain title');
  });
});

describe('stripDays', () => {
  it('runs today through fourteen days out, weekends marked in the team zone', () => {
    const days = stripDays(NOW); // Sat 2026-10-17
    expect(days).toHaveLength(15);
    expect(days.filter((d) => d.weekend).map((d) => d.offset)).toEqual([0, 1, 7, 8, 14]);
  });
});
