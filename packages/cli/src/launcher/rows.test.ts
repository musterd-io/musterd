import { describe, expect, it } from 'vitest';
import { sinceLabel } from '../render/theme.js';
import {
  ago,
  describeLive,
  describeLiveLong,
  describeWhere,
  formatDuration,
  formatReceipt,
  liveQuestion,
  liveSummary,
  renderSeatsList,
  seatLine,
  wakeMenu,
  wakeReason,
} from './rows.js';
import type { Seat } from './store.js';

const NOW = Date.UTC(2026, 9, 1, 18, 0, 0);
const H = 3_600_000;
const seat = (member: string, over: Partial<Seat> = {}): Seat => ({
  address: `revive/agents/${member}`,
  team: 'revive',
  project: 'agents',
  member,
  server: 'http://127.0.0.1:4849',
  path: `/w/${member}`,
  kind: 'agent',
  harnesses: ['claude-code'],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});

describe('launcher rows (ADR 491)', () => {
  it('ago / duration', () => {
    expect([
      ago(NOW - 30_000, NOW),
      ago(NOW - 5 * 60_000, NOW),
      ago(NOW - 2 * H, NOW),
      ago(NOW - 26 * H, NOW),
    ]).toEqual(['now', '5m', '2h', '1d']);
    expect([
      formatDuration(9_000),
      formatDuration(42 * 60_000),
      formatDuration(125 * 60_000),
    ]).toEqual(['9s', '42m', '2h 5m']);
  });

  it('the receipt is one line', () => {
    expect(formatReceipt('stanley', 'claude-code', 42 * 60_000, 0)).toBe(
      '✓ stanley · claude · 42m · exit 0 · musterd - to go back',
    );
    expect(formatReceipt('stanley', 'codex', 9_000, 7)).toBe(
      '✗ stanley · codex · 9s · exit 7 · musterd - to go back',
    );
  });

  it('describes where a seat is live', () => {
    const here = { where: 'here' as const, label: 'here', surface: 'claude-code', since: NOW - H };
    expect(describeLive(here, NOW)).toBe(`here · since ${sinceLabel(NOW - H, NOW)}`);
    expect(describeLiveLong({ ...here, where: 'elsewhere', label: 'mini-2' }, NOW)).toBe(
      `on mini-2 (claude-code) since ${sinceLabel(NOW - H, NOW)}`,
    );
  });

  describe('the live-seat question names a wake (ADR 543)', () => {
    const here = { where: 'here' as const, label: 'here', surface: 'claude-code', since: NOW - H };
    const since = sinceLabel(NOW - H, NOW);
    const why = (over: Partial<NonNullable<Parameters<typeof wakeReason>[0]>>) => ({
      edge: null,
      lane_id: null,
      act_id: null,
      act: null,
      from: null,
      ...over,
    });

    it('a session a person opened keeps the plain question', () => {
      expect(liveQuestion('dolly', here, NOW)).toBe(
        `dolly is live here (claude-code) since ${since}. Open a second session in the same folder? (y/N)`,
      );
      expect(liveSummary(here, NOW)).toBe(`here (claude-code) since ${since}`);
    });

    it('a wake says so, why, that it is expected, and what a second session does to it', () => {
      const live = {
        ...here,
        wake: why({ edge: 'dispatch_continuation', lane_id: '01M46YWG8YHEV2SKW9F1N0W8FG' }),
      };
      expect(liveQuestion('dolly', live, NOW)).toBe(
        `dolly is live here (claude-code) since ${since} — a wake: musterd started it headless to carry on with lane 01M46YWG8Y. ` +
          `That's expected; it exits when the work is done. ` +
          `A second session replaces it within seconds and cuts that work off. Open one anyway? (y/N)`,
      );
      expect(liveSummary(live, NOW)).toBe(
        `here (claude-code) since ${since} — a wake to carry on with lane 01M46YWG8Y`,
      );
    });

    it('a wake the daemon cannot explain still says it is a wake', () => {
      expect(liveQuestion('dolly', { ...here, wake: null }, NOW)).toMatch(
        /— a wake: musterd started it headless\. That's expected;/,
      );
    });

    it('each reason reads as prose', () => {
      const lane = '01M49MEFFRNKSZ0KAYXVY96BTR';
      expect(wakeReason(why({ edge: 'review', lane_id: lane, act: 'ask', from: 'ghost' }))).toBe(
        ' to judge lane 01M49MEFFR for acceptance',
      );
      expect(wakeReason(why({ edge: 'dispatch_handoff', lane_id: lane, from: 'stanley' }))).toBe(
        ' for lane 01M49MEFFR, handed over from stanley',
      );
      expect(wakeReason(why({ lane_id: lane }))).toBe(' for lane 01M49MEFFR');
      expect(wakeReason(why({ act: 'ask', from: 'ghost' }))).toBe(' to answer an ask from ghost');
      expect(wakeReason(why({ act: 'request_help' }))).toBe(' to answer a help request');
      expect(wakeReason(why({}))).toBe('');
      expect(wakeReason(null)).toBe('');
    });
  });

  it('a seat line, with and without the address and harness columns', () => {
    const s = seat('stanley');
    expect(
      seatLine(s, {
        selected: true,
        nameWidth: 9,
        addressWidth: 15,
        showHarness: true,
        harness: 'claude-code',
        state: 'idle',
        tail: '★ last used · 2h',
      }),
    ).toBe('› stanley  revive/agents  claude   ○ idle  ★ last used · 2h');
    expect(
      seatLine(s, {
        selected: false,
        nameWidth: 9,
        addressWidth: null,
        showHarness: false,
        harness: 'claude-code',
        state: 'live',
        tail: 'here',
      }),
    ).toBe('  stanley  ● live  here');
    expect(
      seatLine(seat('nick', { kind: 'human' }), {
        selected: false,
        nameWidth: 9,
        addressWidth: null,
        showHarness: true,
        harness: 'human',
        state: 'unknown',
        tail: '',
      }),
    ).toBe('  nick     human    ?');
  });

  it('`musterd seats` groups by team/project', () => {
    const out = renderSeatsList(
      [
        { seat: seat('stanley'), live: null, lastUsed: NOW - 2 * H },
        {
          seat: seat('miley'),
          live: { where: 'here', label: 'here', surface: 'claude-code', since: NOW - H },
          lastUsed: null,
        },
        {
          seat: seat('gptbot', {
            harnesses: ['codex'],
            problem: { kind: 'binding-invalid', fix: 'x' },
          }),
          live: null,
          lastUsed: null,
        },
      ],
      2,
      NOW,
    );
    expect(out).toBe(
      [
        'seats on this machine · 3',
        '',
        'revive/agents',
        '  stanley  claude   ○ idle  2h',
        `  miley    claude   ● live  here · since ${sinceLabel(NOW - H, NOW)}`,
        '  gptbot   codex    ○ idle  needs repair',
        '',
        '2 stale · musterd init --prune-bindings --apply',
      ].join('\n'),
    );
  });
});

describe('roster-first rows in `musterd seats` (ADR 503)', () => {
  it('describes where a member lives', () => {
    expect(describeWhere({ where: 'here', where_label: null })).toBe('here');
    expect(describeWhere({ where: 'node', where_label: 'air-2' })).toBe('on air-2');
    expect(describeWhere({ where: 'cloud', where_label: 'fly' })).toBe('cloud · fly');
    expect(describeWhere({ where: 'nowhere', where_label: null })).toBe('nowhere');
    // A node label is painted on the terminal: control bytes in it are dropped, never written.
    expect(describeWhere({ where: 'node', where_label: 'air\x1b[31m-2\x07' })).toBe('on air[31m-2');
  });

  it('lists members with no folder here under their team, with where and can', () => {
    const entries = [{ seat: seat('ada'), live: null, lastUsed: null }];
    const members = [
      {
        team: 'revive',
        member: 'ada',
        kind: 'agent',
        address: 'revive/agents/ada',
        where: 'here',
        node: 'n',
        where_label: null,
        can: 'launch',
      },
      {
        team: 'revive',
        member: 'bo',
        kind: 'agent',
        address: null,
        where: 'node',
        node: 'n2',
        where_label: 'air-2',
        can: 'wake',
      },
      {
        team: 'revive',
        member: 'cy',
        kind: 'agent',
        address: null,
        where: 'nowhere',
        node: null,
        where_label: null,
        can: 'setup',
      },
    ] as const;
    const out = renderSeatsList(entries, 0, NOW, {
      members: [...members],
      rosterMissing: ['dawn'],
    });
    expect(out).toContain('revive · on the team');
    expect(out).toContain('bo  on air-2  wake');
    expect(out).toContain('cy  nowhere  set up');
    expect(out).not.toMatch(/on the team[\s\S]*ada/);
    expect(out).toContain("dawn: roster unavailable — this machine's folders only");
  });
});

describe('wakeMenu (ADR 546)', () => {
  const H = 3_600_000;
  const live = {
    where: 'here' as const,
    label: 'here',
    surface: 'claude-code',
    since: NOW - H,
    wake: {
      edge: 'dispatch_continuation' as const,
      lane_id: '01M46YWG8YHEV2SKW9F1N0W8FG',
      act_id: null,
      act: null,
      from: null,
    },
  };
  it('names the wake, why, and the three keys', () => {
    expect(wakeMenu('dolly', live, NOW)).toEqual([
      `dolly is busy — a wake started ${sinceLabel(NOW - H, NOW)} to carry on with lane 01M46YWG8Y.`,
      '  ⏎  take over   stop the wake, continue its conversation here',
      '  w  watch       follow it live; ⏎ takes over at any point',
      '  esc cancel',
    ]);
  });
  it('drops the clauses the roster could not fill', () => {
    expect(wakeMenu('dolly', { ...live, since: null, wake: null }, NOW)[0]).toBe(
      'dolly is busy — a wake.',
    );
  });
});
