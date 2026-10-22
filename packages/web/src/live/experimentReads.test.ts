import type { LaneBoard } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  capEntries,
  clockPhrase,
  evidenceUrl,
  experimentEntries,
  firstSentence,
  formatValue,
  readDayStart,
  resultPhrase,
  sparkline,
  experimentsCount,
  READ_SHOWN_MS,
  shortTitle,
  stripDays,
  teamToday,
  readLiveSamples,
  withLivePoints,
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

  it('on the stream, a charted row takes a free slot before an uncharted one, in group order', () => {
    const all = entries(Array(8).fill('waiting')).map((e, i) =>
      i === 6 ? { ...e, metric: { name: 'm', unit: '%', baseline: null, target: 1, direction: 'up' } as never, samples: [{ day: '2026-10-21', value: 1, n: 1 }] } : e,
    );
    expect(capEntries(all).map((e) => e.id)).not.toContain(all[6]!.id);
    const stream = capEntries(all, true);
    expect(stream).toHaveLength(5);
    expect(stream.map((e) => e.id)).toContain(all[6]!.id);
    expect(stream.at(-1)!.id).toBe(all[6]!.id); // still in its place in the order
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
  it("does not name a read by its kind: 'Experiment: felt vs real — …' is 'felt vs real'", () => {
    expect(shortTitle('Experiment: felt vs real — does work nick asks for take longer')).toBe('felt vs real');
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


describe('the countdown (lane 01M5AXHFZT) — toward the team\'s read day, read every minute', () => {
  it('a read day begins at 00:00 in the team zone, DST included', () => {
    expect(new Date(readDayStart('2026-10-20')).toISOString()).toBe('2026-10-20T07:00:00.000Z'); // PDT
    expect(new Date(readDayStart('2026-12-01')).toISOString()).toBe('2026-12-01T08:00:00.000Z'); // PST
  });

  it('waiting counts down in the units that matter', () => {
    const start = readDayStart('2026-10-22');
    const e = { status: 'waiting' as const, readsOn: '2026-10-22', phrase: 'in 2 days' };
    expect(clockPhrase(e, start - (2 * 86_400_000 + 14 * 3_600_000 + 5 * 60_000))).toBe('2d 14h 05m');
    expect(clockPhrase(e, start - (14 * 3_600_000 + 5 * 60_000))).toBe('14h 05m');
    expect(clockPhrase(e, start - 5 * 60_000)).toBe('05m');
    // The midnight seam: the server still says waiting, the clock already says due.
    expect(clockPhrase(e, start + 1)).toBe('due today');
  });

  it('due counts what is left of the day; overdue counts up', () => {
    const start = readDayStart('2026-10-19');
    expect(clockPhrase({ status: 'due', readsOn: '2026-10-19', phrase: 'due today' }, start + 15 * 3_600_000)).toBe(
      'today · 9h 00m left',
    );
    const od = { status: 'overdue' as const, readsOn: '2026-10-17', phrase: 'overdue · 2 days' };
    expect(clockPhrase(od, start + 4 * 3_600_000 + 12 * 60_000)).toBe('overdue · 2d 04h');
    expect(clockPhrase(od, readDayStart('2026-10-17') + 4 * 3_600_000 + 12 * 60_000)).toBe('overdue · 4h 12m');
  });

  it('a read row keeps its verdict word', () => {
    expect(clockPhrase({ status: 'read', readsOn: '2026-10-10', phrase: 'met' }, Date.now())).toBe('met');
  });
});

describe('the result beside the word (experiment-results design §5–6, lane 01M5B1ZM80)', () => {
  const metric = { name: 'ranked pick hit rate', unit: '%', baseline: 40, target: 60, direction: 'up' as const };

  it('formats a value in its unit', () => {
    expect(formatValue(61.04, '%')).toBe('61%');
    expect(formatValue(61.25, '%')).toBe('61.3%');
    // Durations read as durations: the wake-latency chart showed "2223647 ms" for 37 minutes.
    expect(formatValue(840, 'ms')).toBe('840 ms');
    expect(formatValue(53076, 'ms')).toBe('53 s');
    expect(formatValue(60000, 'ms')).toBe('1 min');
    expect(formatValue(2223647, 'ms')).toBe('37 min');
    expect(formatValue(235728726, 'ms')).toBe('2.7 d');
    expect(formatValue(812.6, 'ms')).toBe('813 ms');
    expect(formatValue(0.4567, 'per day')).toBe('0.46 per day');
    expect(formatValue(1234, 'count')).toBe('1234 count');
  });

  it('a read with a measured value says how, not just whether; without one the word stands alone', () => {
    expect(resultPhrase({ status: 'read', phrase: 'met', metric, measured: { value: 61, n: 23 } })).toBe(
      'met · 61% (target 60%, n 23)',
    );
    expect(resultPhrase({ status: 'read', phrase: 'missed', metric: null, measured: { value: 3, n: 9 } })).toBe(
      'missed · 3 (n 9)',
    );
    expect(resultPhrase({ status: 'read', phrase: 'met', metric, measured: null })).toBe('met');
    expect(resultPhrase({ status: 'waiting', phrase: 'in 2 days', metric, measured: null })).toBe('in 2 days');
  });

  it('draws nothing without a metric or a sample; keeps the target in frame otherwise', () => {
    expect(sparkline(null, [{ day: '2026-10-18', value: 50, n: 3 }, { day: '2026-10-19', value: 55, n: 4 }])).toBeNull();
    expect(sparkline(metric, [])).toBeNull();
    const s = sparkline(metric, [
      { day: '2026-10-17', value: 42, n: 5 },
      { day: '2026-10-18', value: 50, n: 3 },
      { day: '2026-10-19', value: 61, n: 4 },
    ])!;
    expect(s.latest).toBe('61%');
    expect(s.path.startsWith('M0 ')).toBe(true);
    expect(s.path.split(' L')).toHaveLength(3);
    // The target rule sits inside the box, above the baseline rule (higher value → smaller y).
    expect(s.targetY).toBeGreaterThan(0);
    expect(s.targetY).toBeLessThan(16);
    expect(s.targetY).toBeLessThan(s.baselineY!);
  });

  it('the stream shows a note\'s first sentence; evidence is a link only when it is a web address', () => {
    expect(firstSentence('Ranked picks won 61% of the time. Baseline held at 40%.')).toBe(
      'Ranked picks won 61% of the time.',
    );
    expect(firstSentence('no punctuation at all')).toBe('no punctuation at all');
    expect(evidenceUrl('https://github.com/musterd-io/musterd/pull/2961')).toBe(
      'https://github.com/musterd-io/musterd/pull/2961',
    );
    expect(evidenceUrl('scripts/research/next-readout.ts')).toBeNull();
    expect(evidenceUrl('javascript:alert(1)')).toBeNull();
    expect(evidenceUrl(null)).toBeNull();
  });

  it('reads metric, samples, measured and evidence off a lane that carries them, and nothing off one that does not', () => {
    const NOW = Date.UTC(2026, 9, 17, 22);
    const board = {
      lanes: [
        {
          id: 'L1',
          title: 'Does ranking help?',
          reads_on: '2026-10-16',
          read_status: 'read',
          read_verdict: { outcome: 'met', note: 'Yes. Clearly.', by: 'ryder', at: NOW, measured: { value: 61, n: 23 }, evidence: 'ADR-536' },
          metric: { ...metric, source: 'manual', by: 'ryder', at: 1 },
          samples: [
            { day: '2026-10-15', value: 55, n: 2, by: 'ryder', at: 1 },
            { day: '2026-10-14', value: 48, n: 2, by: 'ryder', at: 1 },
          ],
        },
        { id: 'L2', title: 'Plain read', reads_on: '2026-10-16', read_status: 'read', read_verdict: { outcome: 'met', note: 'ok', by: 'x', at: NOW } },
      ],
      warnings: [],
    } as unknown as LaneBoard;
    const [a, b] = experimentEntries(board, NOW);
    expect(a!.metric?.name).toBe('ranked pick hit rate');
    expect(a!.samples.map((s) => s.day)).toEqual(['2026-10-14', '2026-10-15']); // oldest first
    expect(a!.measured).toEqual({ value: 61, n: 23 });
    expect(a!.evidence).toBe('ADR-536');
    expect(a!.label).toContain('measured 61% against 60%');
    expect(b!.metric).toBeNull();
    expect(b!.samples).toEqual([]);
    expect(b!.measured).toBeNull();
  });
});

describe('live points (ADR 701)', () => {
  const metric = { name: 'disputes per verdict', unit: 'per verdict', baseline: null, target: 0.15, direction: 'up' as const };
  const metricLane = (id: string, samples: object[], over: Record<string, unknown> = {}) =>
    lane(id, { reads_on: '2026-10-28', read_status: 'waiting', metric, samples, ...over });

  it('reads the endpoint defensively: a malformed row is dropped, a missing body is no points', () => {
    expect(readLiveSamples(null)).toEqual([]);
    expect(readLiveSamples({ samples: 'x' })).toEqual([]);
    expect(
      readLiveSamples({
        samples: [
          { lane: 'L1', day: '2026-10-17', value: 0.2, n: 5, as_of: NOW },
          { lane: 'L2', day: '2026-10-17', value: 'lots', n: 5, as_of: NOW },
        ],
      }),
    ).toEqual([{ lane: 'L1', day: '2026-10-17', value: 0.2, n: 5, as_of: NOW }]);
  });

  it("puts today's live point on the series: replacing today's stored row, or after the history", () => {
    const entries = experimentEntries(
      board(
        metricLane('L1', [{ day: '2026-10-16', value: 0.1, n: 4 }, { day: '2026-10-17', value: 0.12, n: 2 }]),
        metricLane('L2', [{ day: '2026-10-16', value: 0.3, n: 3 }]),
        metricLane('L3', [{ day: '2026-10-16', value: 0.3, n: 3 }]),
      ),
      NOW,
    );
    const live = [
      { lane: 'L1', day: '2026-10-17', value: 0.2, n: 5, as_of: NOW },
      { lane: 'L2', day: '2026-10-17', value: 0.25, n: 4, as_of: NOW },
    ];
    const merged = withLivePoints(entries, live);
    const byId = (id: string) => merged.find((e) => e.id === id)!;
    expect(byId('L1').samples).toEqual([
      { day: '2026-10-16', value: 0.1, n: 4 },
      { day: '2026-10-17', value: 0.2, n: 5, live: true, asOf: NOW },
    ]);
    expect(byId('L2').samples.map((s) => s.value)).toEqual([0.3, 0.25]);
    // No live point: unchanged.
    expect(byId('L3').samples).toEqual([{ day: '2026-10-16', value: 0.3, n: 3 }]);
    // One day of history plus today's live point is a line, ending on a dot.
    const spark = sparkline(byId('L2').metric, byId('L2').samples)!;
    expect(spark.now).toMatchObject({ x: expect.any(Number), y: expect.any(Number), asOf: NOW });
    // One past day, no live point: the number and a still dot at the right edge, no line.
    const lone = sparkline(byId('L3').metric, byId('L3').samples)!;
    expect(lone.path).toBe('');
    expect(lone.now).toBeNull();
    expect(lone.lone).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    expect(lone.latest).not.toBe('');
  });

  it('one sample is enough: today alone shows the number, `now` and the breathing dot (no line)', () => {
    const s = sparkline(metric, [{ day: '2026-10-21', value: 40, n: 2, live: true, asOf: 1 }])!;
    expect(s.path).toBe('');
    expect(s.latest).toMatch(/^40\b/);
    expect(s.now).toMatchObject({ y: expect.any(Number), asOf: 1 });
    expect(Number.isFinite(s.now!.x)).toBe(true);
    expect(s.lone).toBeNull();
  });

  it('a read that is in takes no live point: its chart is the record', () => {
    const entries = experimentEntries(
      board(
        metricLane('L1', [{ day: '2026-10-16', value: 0.1, n: 4 }], {
          state: 'done',
          read_status: 'read',
          read_verdict: { outcome: 'met', note: 'n', by: 'ryder', at: NOW - 1000 },
        }),
      ),
      NOW,
    );
    const merged = withLivePoints(entries, [{ lane: 'L1', day: '2026-10-17', value: 0.9, n: 9, as_of: NOW }]);
    expect(merged[0]!.samples).toEqual([{ day: '2026-10-16', value: 0.1, n: 4 }]);
  });
});
