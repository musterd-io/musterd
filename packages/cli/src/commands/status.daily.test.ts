import { describeHubLink } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { type DailyView, hubWarning, renderDailyView } from '../render/rows.js';
import { visibleLen } from '../render/ui.js';

/**
 * The daily view of `musterd status` against its frames (`figma-brief-terminal.md` "Daily view
 * frames", 27-2/27-4/27-6/27-8): the busy, empty and degraded days at 80 and 40 columns. The data
 * is the frames' own, so a divergence between the code and the frames fails here.
 */
// eslint-disable-next-line no-control-regex
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

const NOW = new Date(2026, 9, 29, 16, 12).getTime();
const MIN = 60_000;

const busy: DailyView = {
  team: 'dawn',
  me: { name: 'Ada', kind: 'agent', role: 'backend', model: 'claude-opus-5-5' },
  waiting: {
    count: 3,
    acts: [
      {
        from: 'nick',
        fromKind: 'human',
        act: 'ask',
        body: 'ship the roster render?',
        ts: NOW - 14 * MIN,
      },
      {
        from: 'Lin',
        fromKind: 'agent',
        act: 'handoff',
        body: 'lane 01ARZ3ND · the new inbox empty states',
        ts: NOW - 60 * MIN,
      },
      {
        from: 'Lin',
        fromKind: 'agent',
        act: 'request_help',
        body: 'daily view layout',
        others: 2,
        ts: NOW - 10_000,
      },
    ],
  },
  lanes: [
    {
      state: 'active',
      title: 'Wire the roster render to the new presence model and drop the old grid',
      merged: true,
    },
    { state: 'claimed', title: 'Backfill the auth audit rows for the September window' },
  ],
  upNext: {
    lanes: [
      { id: '01M6ABCD12', title: 'Desk-level presence for the auth module' },
      { id: '01M6ABCE7Q', title: 'Retire the v1 inbox cursor' },
      { id: '01M6ABCF3R', title: 'A third lane' },
    ],
    total: 3,
  },
  crew: { here: 3, working: 2, blocked: [{ name: 'Lin', kind: 'agent', why: 'waiting on CI' }] },
  warnings: [],
  notReported: [],
};

const rowEnding = (lines: string[], text: string) => lines.find((l) => l.trimEnd().endsWith(text));

describe('musterd status — daily view frames', () => {
  it('busy · 80 (27-2): role and model, ages and hints at column 80, the blocker named', () => {
    const out = plain(renderDailyView(busy, NOW, 80));
    expect(out[0]).toBe('musterd · dawn · 16:12');
    expect(out[1]).toBe('you are Ada · backend · claude-opus-5-5');
    expect(out).toContain('⚑ 3 waiting on you');
    const nick = rowEnding(out, '14m')!;
    expect(nick).toMatch(/^ {2}nick · asks: ship the roster render\? +14m$/);
    expect(nick).toHaveLength(80);
    expect(rowEnding(out, '1h')).toMatch(
      /^ {2}Lin · hands you: lane 01ARZ3ND · the new inbox empty states +1h$/,
    );
    expect(rowEnding(out, 'now')).toMatch(
      /^ {2}Lin · needs help: daily view layout \(you \+ 2 others\) +now$/,
    );
    expect(out).toContain('◆ your work  2');
    const active = rowEnding(out, 'submit')!;
    expect(active).toMatch(/^ {2}landed · Wire the roster render to the new presence.*… +submit$/);
    expect(visibleLen(active)).toBe(80);
    expect(rowEnding(out, 'ready to start')).toMatch(/^ {2}claimed · Backfill the auth audit rows/);
    expect(out).toContain('  Desk-level presence for the auth module — 01M6ABCD12');
    expect(out).toContain('  Retire the v1 inbox cursor — 01M6ABCE7Q');
    expect(out).toContain('  +1 more · musterd next');
    // One pointer per destination: the +more line names the command, so no arrow follows.
    expect(out).not.toContain('  → musterd next');
    expect(out).toContain('team  3 here · 2 working · 1 blocked (Lin: waiting on CI)');
    expect(out).not.toContain('All quiet. musterd next shows open work.');
    for (const line of out) expect(visibleLen(line)).toBeLessThanOrEqual(80);
  });

  it('busy · 40 (27-4): one column — no model, no hints, one up next, the blocker unnamed', () => {
    const out = plain(renderDailyView(busy, NOW, 40));
    expect(out[1]).toBe('you are Ada · backend');
    const nick = rowEnding(out, '14m')!;
    expect(nick).toMatch(
      /^ {2}nick · asks: .*… +14m$|^ {2}nick · asks: ship the roster render\? +14m$/,
    );
    expect(visibleLen(nick)).toBe(40);
    expect(rowEnding(out, '1h')).toMatch(/^ {2}Lin · hands you: lane 01AR.*… +1h$/);
    expect(out.some((l) => l.includes('PR merged'))).toBe(false);
    expect(out.find((l) => l.startsWith('  landed · '))).toMatch(/…$/);
    expect(out.filter((l) => l.includes(' — 01M6'))).toHaveLength(1);
    expect(out).toContain('  +2 more · musterd next');
    expect(out).toContain('3 here · 2 working · 1 blocked');
    for (const line of out) expect(visibleLen(line)).toBeLessThanOrEqual(40);
  });

  it('empty · 80 (27-6): nothing waiting, no lanes, the first up-next lane named', () => {
    const out = plain(
      renderDailyView(
        {
          ...busy,
          waiting: undefined,
          lanes: [],
          upNext: {
            lanes: [{ id: '01M6ABCD12', title: 'Desk-level presence for the auth module' }],
            total: 1,
          },
          crew: { here: 1, working: 0, blocked: [] },
        },
        new Date(2026, 9, 29, 9, 2).getTime(),
        80,
      ),
    );
    expect(out).toEqual([
      'musterd · dawn · 09:02',
      'you are Ada · backend · claude-opus-5-5',
      '',
      '⚑ nothing waiting on you',
      '',
      'You hold no lanes.',
      'pick one up  musterd lane claim 01M6ABCD12',
      '',
      '○ up next',
      '  Desk-level presence for the auth module — 01M6ABCD12',
      '  → musterd next',
      '',
      'team  1 here · nobody working yet',
    ]);
  });

  it('empty with nothing up next ends all quiet', () => {
    const out = plain(
      renderDailyView(
        {
          ...busy,
          waiting: undefined,
          lanes: [],
          upNext: { lanes: [], total: 0 },
          crew: { here: 1, working: 0, blocked: [] },
        },
        NOW,
        80,
      ),
    );
    expect(out.at(-1)).toBe('All quiet. musterd next shows open work.');
    expect(out).not.toContain('pick one up  musterd lane claim');
  });

  it('degraded · 80 (27-8): up next says why it is missing, the team line its age, ⚠ lines their fix', () => {
    const out = plain(
      renderDailyView(
        {
          ...busy,
          waiting: { count: 1, acts: [busy.waiting!.acts[0]!] },
          lanes: [busy.lanes[0]!],
          upNext: { unreadable: 'the hub cannot be read' },
          crew: { here: 3, working: 2, blocked: [], asOf: new Date(2026, 9, 29, 20, 22).getTime() },
          warnings: [
            {
              line: '⚠ hub dawn-hub unreachable since 12m — the hub did not answer in time; last sync 14m ago',
              fix: 'musterd node list',
            },
            {
              line: '⚠ your CLI build (979bac1) differs from the daemon (1cfceb5)',
              fix: 'rebuild your checkout (pnpm build)',
            },
          ],
        },
        NOW,
        80,
      ),
    );
    expect(out).toContain('○ up next  — not shown: the hub cannot be read');
    expect(out.some((l) => l.includes('musterd next'))).toBe(false);
    expect(out).toContain('team  as of 20:22 — 3 here · 2 working');
    const hub = out.findIndex((l) => l.startsWith('⚠ hub dawn-hub unreachable'));
    expect(out[hub]).toMatch(/…$/);
    expect(visibleLen(out[hub]!)).toBeLessThanOrEqual(80);
    expect(out[hub + 1]).toBe('  → musterd node list');
    expect(out[hub + 2]).toBe('⚠ your CLI build (979bac1) differs from the daemon (1cfceb5)');
    expect(out[hub + 3]).toBe('  → rebuild your checkout (pnpm build)');
    expect(out).not.toContain('All quiet. musterd next shows open work.');
  });

  // ADR 757: the settled layout, line for line — a fixed right column per section, so a cut row and
  // its age or hint land where the frames put them. A change here is a change to the frames.
  it('busy · 80 (27-2), exactly', () => {
    expect(plain(renderDailyView(busy, NOW, 80))).toEqual([
      'musterd · dawn · 16:12',
      'you are Ada · backend · claude-opus-5-5',
      '',
      '⚑ 3 waiting on you',
      '  nick · asks: ship the roster render?                                       14m',
      '  Lin · hands you: lane 01ARZ3ND · the new inbox empty states                 1h',
      '  Lin · needs help: daily view layout (you + 2 others)                       now',
      '  → musterd inbox',
      '',
      '◆ your work  2',
      '  landed · Wire the roster render to the new presence model…              submit',
      '  claimed · Backfill the auth audit rows for the September…       ready to start',
      '',
      '○ up next',
      '  Desk-level presence for the auth module — 01M6ABCD12',
      '  Retire the v1 inbox cursor — 01M6ABCE7Q',
      '  +1 more · musterd next',
      '',
      'team  3 here · 2 working · 1 blocked (Lin: waiting on CI)',
    ]);
  });

  it('busy · 40 (27-4), exactly', () => {
    expect(plain(renderDailyView(busy, NOW, 40))).toEqual([
      'musterd · dawn · 16:12',
      'you are Ada · backend',
      '',
      '⚑ 3 waiting on you',
      '  nick · asks: ship the roste…       14m',
      '  Lin · hands you: lane 01ARZ…        1h',
      '  Lin · needs help: daily vie…       now',
      '  → musterd inbox',
      '',
      '◆ your work  2',
      '  landed · Wire the roster rend…',
      '  claimed · Backfill the auth a…',
      '',
      '○ up next',
      '  Desk-level presence for… — 01M6ABCD12',
      '  +2 more · musterd next',
      '',
      '3 here · 2 working · 1 blocked',
    ]);
  });

  it('a lane with its acceptor says so instead of asking for a submit', () => {
    const out = plain(
      renderDailyView(
        { ...busy, lanes: [{ state: 'awaiting_acceptance', title: 'X', merged: true }] },
        NOW,
        80,
      ),
    );
    expect(rowEnding(out, 'with the acceptor')).toMatch(
      /^ {2}awaiting_acceptance · X +with the acceptor$/,
    );
  });

  it('falls back to the member kind when the seat has no role or model', () => {
    const out = plain(renderDailyView({ ...busy, me: { name: 'Ada', kind: 'agent' } }, NOW, 80));
    expect(out[1]).toBe('you are Ada · agent');
  });

  it("words the hub's ⚠ line as the frame does, from the shared helper's line", () => {
    const line = describeHubLink(
      {
        hub: 'dawn-hub',
        last_ok_at: NOW - 14 * MIN,
        failing_since: NOW - 12 * MIN,
        failure: { kind: 'timeout', code: null, tailscale: null },
      },
      NOW,
    ).line;
    expect(hubWarning(line)).toBe(
      '⚠ hub dawn-hub unreachable since 12m — the hub did not answer in time; last sync 14m ago',
    );
  });
});
