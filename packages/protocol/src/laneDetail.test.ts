import { describe, expect, it } from 'vitest';
import {
  deriveLaneAreas,
  LANE_AREAS,
  laneDetailLines,
  LaneDetailSchema,
  laneEventLine,
  isBareLaneId,
  laneIdQuery,
  LaneQuerySchema,
  type LaneDetail,
  type LaneEvent,
} from './lanes.js';

/** ADR 582 §4: the single-lane read's contract and the lines both surfaces render from it. */

const at = (h: number, m = 0) => Date.UTC(2026, 9, 15, h, m);

const LANE = {
  id: '01M4VKS6SFNNN5TMWQR4NJ6TXT',
  team: 'dawn',
  project: 'runtime',
  title: 'find-work 4',
  detail: null,
  owner_seat: 'TJ',
  role: null,
  scope: [],
  depends_on: [],
  branch: null,
  goal_id: null,
  risk: [],
  merged: null,
  state: 'active',
  created_by: 'izzo',
  created_at: 0,
  claimed_at: 0,
  resolved_at: null,
  updated_at: 0,
} as const;

function detail(over: Partial<LaneDetail> & { lane?: Partial<LaneDetail['lane']> } = {}) {
  return LaneDetailSchema.parse({
    warnings: [],
    history: [],
    acceptance_ask: null,
    ...over,
    lane: { ...LANE, ...over.lane },
  });
}

describe('isBareLaneId', () => {
  it('is a full 26-character lane id, any case, surrounding space ignored', () => {
    expect(isBareLaneId('01M50C1ZZMJFRG409G6TC4S303')).toBe(true);
    expect(isBareLaneId(' 01m4vkrxex53sf0wkgpd1pa97t ')).toBe(true);
  });

  it('is not a prefix, a date, a word, or a title that mentions an id', () => {
    for (const t of [
      '01M50C1ZZM',
      '20261015',
      'standard',
      'follow-up to 01M50C1ZZMJFRG409G6TC4S303',
      '81M50C1ZZMJFRG409G6TC4S303',
      '01M50C1ZZMJFRG409G6TC4S30I',
    ])
      expect(isBareLaneId(t)).toBe(false);
  });
});

describe('laneIdQuery', () => {
  it('takes a ULID or a prefix of 8+, any case, and normalizes to upper', () => {
    expect(laneIdQuery('01m4vks6sf')).toBe('01M4VKS6SF');
    expect(laneIdQuery(' 01M4VKS6SFNNN5TMWQR4NJ6TXT ')).toBe('01M4VKS6SFNNN5TMWQR4NJ6TXT');
  });

  it('refuses what is not an id: words, query terms, short or out-of-alphabet refs', () => {
    for (const q of [
      'standard',
      'goal:launch',
      'sync',
      '01M4VKS',
      '01M4VKS6SI',
      '8ZZZZZZZZZ',
      '',
    ]) {
      expect(laneIdQuery(q)).toBeNull();
    }
  });

  it('LaneQuerySchema trims and bounds the argument', () => {
    expect(LaneQuerySchema.parse('  01M4VKS6SF ')).toBe('01M4VKS6SF');
    expect(LaneQuerySchema.safeParse('   ').success).toBe(false);
    expect(LaneQuerySchema.safeParse('x'.repeat(201)).success).toBe(false);
  });
});

describe('laneEventLine', () => {
  const line = (e: Omit<LaneEvent, 'ts'>) => laneEventLine({ ts: at(10, 5), ...e });

  it('says each recorded edge in words', () => {
    expect(line({ action: 'lane.opened', actor: 'izzo' })).toBe('2026-10-15 10:05 izzo opened');
    expect(line({ action: 'lane.claimed', actor: 'TJ', owner: 'TJ', kind: 'claim' })).toBe(
      '2026-10-15 10:05 TJ claimed by TJ',
    );
    expect(
      line({
        action: 'lane.claimed',
        actor: 'TJ',
        owner: 'bo',
        previous_owner: 'TJ',
        kind: 'handoff',
      }),
    ).toBe('2026-10-15 10:05 TJ handed to bo from TJ');
    expect(line({ action: 'lane.state_changed', actor: 'TJ', from: 'claimed', to: 'active' })).toBe(
      '2026-10-15 10:05 TJ claimed → active',
    );
    expect(line({ action: 'lane.updated', actor: 'TJ', fields: ['branch', 'scope'] })).toBe(
      '2026-10-15 10:05 TJ edited branch, scope',
    );
    expect(line({ action: 'lane.updated', actor: 'TJ' })).toBe('2026-10-15 10:05 TJ edited fields');
    expect(line({ action: 'lane.released', actor: 'nick', owner: 'TJ' })).toBe(
      '2026-10-15 10:05 nick released (was TJ)',
    );
    expect(line({ action: 'lane.ready_for_review', actor: 'TJ' })).toBe(
      '2026-10-15 10:05 TJ submitted for acceptance',
    );
    expect(
      line({
        action: 'lane.closed',
        actor: 'schmidt',
        to: 'done',
        verified: true,
        reason: 'accepted',
      }),
    ).toBe('2026-10-15 10:05 schmidt closed done (confirmed) — accepted');
    expect(line({ action: 'lane.closed', actor: 'TJ', verified: false })).toBe(
      '2026-10-15 10:05 TJ closed (unconfirmed)',
    );
  });

  it('renders an action it does not know, so a newer daemon still reads', () => {
    expect(line({ action: 'lane.review_rerouted', actor: null, reviewer: 'gee' })).toBe(
      '2026-10-15 10:05 — review rerouted (gee)',
    );
    expect(line({ action: 'other.thing', actor: 'x' })).toBe('2026-10-15 10:05 x other.thing');
  });
});

describe('laneDetailLines', () => {
  it('a bare lane with no history adds nothing under its board line', () => {
    expect(laneDetailLines(detail())).toEqual([]);
  });

  it('carries the brief, merge, follow-ups, the ask to reply to, and the history in order', () => {
    const lines = laneDetailLines(
      detail({
        lane: {
          detail: 'the brief',
          state: 'awaiting_acceptance',
          merged: {
            pr: 12,
            sha: 'abcdef1234567890',
            authorized_by: 'nick',
            verification: 'ancestor',
          },
          follows_up: ['01M50AAAAA'],
        },
        acceptance_ask: { id: 'ASK1', to: 'schmidt' },
        history: [
          { ts: at(9), action: 'lane.opened', actor: 'izzo' },
          { ts: at(10), action: 'lane.ready_for_review', actor: 'TJ' },
        ],
      }),
    );
    expect(lines).toEqual([
      'brief: the brief',
      'merged: #12 abcdef1234 ancestor authorized by nick',
      'follows up: 01M50AAAAA',
      "acceptance ask ASK1 → schmidt — verdict: team_send {act:'accept'|'decline', reply_to:'ASK1'}",
      'history:',
      '  2026-10-15 09:00 izzo opened',
      '  2026-10-15 10:00 TJ submitted for acceptance',
    ]);
  });

  it('says how a done lane closed, and what an abandoned one was dropped for', () => {
    expect(
      laneDetailLines(
        detail({ lane: { state: 'done', verified: false, follows_up: 'none', merged: {} } }),
      ),
    ).toEqual(['merged: yes', 'follows up: none', 'closed unconfirmed']);
    expect(
      laneDetailLines(detail({ lane: { state: 'abandoned', abandon_reason: 'superseded' } })),
    ).toEqual(['abandoned: superseded']);
    expect(
      laneDetailLines(detail({ lane: { areas: ['ui', 'docs'], declared_areas: ['ui', 'docs'] } })),
    ).toEqual(['areas: ui, docs (declared)']);
  });
});

describe('deriveLaneAreas (ADR 582 §3)', () => {
  it('derives areas from path segments in canonical order, including brace expansions and top-level markdown', () => {
    expect(deriveLaneAreas([])).toEqual([]);
    expect(deriveLaneAreas(['packages/web/src/live/Board.tsx'])).toEqual(['ui']);
    expect(
      deriveLaneAreas(['packages/server/src/store/lanes.ts', 'packages/protocol/src/lanes.ts']),
    ).toEqual(['server', 'protocol']);
    expect(
      deriveLaneAreas(['packages/cli/src/commands/lane.ts', 'packages/mcp/src/tools/lanes.ts']),
    ).toEqual(['cli', 'mcp']);
    expect(
      deriveLaneAreas([
        'docs/decisions/582-finding-work.md',
        '.github/workflows/ci.yml',
        'scripts/perf/check.ts',
      ]),
    ).toEqual(['docs', 'ci']);
    expect(deriveLaneAreas(['AGENTS.md'])).toEqual(['docs']);
    expect(
      deriveLaneAreas(['packages/web/src/live/office-scene/{render.ts, render.test.ts}']),
    ).toEqual(['ui', 'tests']);
    expect(deriveLaneAreas(['tests/scenarios/flagship.e2e.ts'])).toEqual(['tests']);
    expect(LANE_AREAS).toEqual(['ui', 'server', 'cli', 'mcp', 'protocol', 'docs', 'ci', 'tests']);
  });

  it('declared areas replace derived ones instead of adding to them', () => {
    expect(
      deriveLaneAreas(['packages/web/src/live/Board.tsx'], ['server', ' CLI ', 'server']),
    ).toEqual(['server', 'cli']);
    expect(deriveLaneAreas(['packages/web/src/live/Board.tsx'], [])).toEqual(['ui']);
    expect(deriveLaneAreas(['packages/web/src/live/Board.tsx'], null)).toEqual(['ui']);
  });
});
