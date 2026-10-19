import { type Goal, type Lane, LaneSchema, parseBoardQuery } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { matchGoalQuery, matchLaneQuery } from './boardQuery.js';

/** A lane that parses against the wire schema, so a fixture cannot drift from it. */
function lane(over: Partial<Lane> = {}): Lane {
  return LaneSchema.parse({
    id: '01M4VKRXEX53SF0WKGPD1PA97T',
    team: 'revive',
    project: 'runtime',
    title: 'find-work 1: lane_board takes a text query',
    detail: 'Text query over title + detail, goal, path, role, risk and area.',
    owner_seat: 'dreamy',
    role: 'platform',
    scope: ['packages/protocol/src/**', 'packages/server/src/store/**'],
    areas: ['protocol', 'server'],
    depends_on: [],
    branch: null,
    goal_id: 'find-work',
    risk: ['security'],
    state: 'claimed',
    created_by: 'dreamy',
    created_at: 1,
    claimed_at: 2,
    resolved_at: null,
    updated_at: 3,
    ...over,
  });
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'find-work',
    title: 'Finding work on the board',
    wave: null,
    depends_on: [],
    declared_by: 'nick',
    declared_at: 1,
    status: 'in-flight',
    epoch: 0,
    ...over,
  };
}

const q = (s: string) => parseBoardQuery(s);

describe('matchLaneQuery', () => {
  it('matches a bare word against the title and the detail', () => {
    expect(matchLaneQuery(lane(), q('text query'))).toBe(true);
    expect(matchLaneQuery(lane(), q('text'))).toBe(true);
    expect(matchLaneQuery(lane(), q('nothing here'))).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(matchLaneQuery(lane(), q('TEXT QUERY'))).toBe(true);
  });

  it('ANDs the bare words', () => {
    expect(matchLaneQuery(lane(), q('find-work text'))).toBe(true);
    expect(matchLaneQuery(lane(), q('find-work absent'))).toBe(false);
  });

  it('matches a quoted phrase as one run of text', () => {
    expect(matchLaneQuery(lane(), q('"text query"'))).toBe(true);
    expect(matchLaneQuery(lane(), q('"query text"'))).toBe(false);
  });

  it('matches each keyed field', () => {
    const l = lane();
    expect(matchLaneQuery(l, q('goal:find-work'))).toBe(true);
    expect(matchLaneQuery(l, q('goal:other'))).toBe(false);
    expect(matchLaneQuery(l, q('area:protocol'))).toBe(true);
    expect(matchLaneQuery(l, q('area:ui'))).toBe(false);
    expect(matchLaneQuery(l, q('owner:dreamy'))).toBe(true);
    expect(matchLaneQuery(l, q('owner:stanley'))).toBe(false);
    expect(matchLaneQuery(l, q('state:claimed'))).toBe(true);
    expect(matchLaneQuery(l, q('role:platform'))).toBe(true);
    expect(matchLaneQuery(l, q('risk:security'))).toBe(true);
    expect(matchLaneQuery(l, q('risk:cost'))).toBe(false);
    expect(matchLaneQuery(l, q('project:runtime'))).toBe(true);
  });

  it('keeps a lane whose surface overlaps the path', () => {
    const l = lane();
    expect(matchLaneQuery(l, q('path:packages/protocol/src/lanes.ts'))).toBe(true);
    expect(matchLaneQuery(l, q('path:packages/web/src/app.tsx'))).toBe(false);
  });

  it('ORs repeats of one key and ANDs across keys', () => {
    const l = lane();
    expect(matchLaneQuery(l, q('state:claimed state:open'))).toBe(true);
    expect(matchLaneQuery(l, q('state:open state:done'))).toBe(false);
    expect(matchLaneQuery(l, q('state:claimed area:ui'))).toBe(false);
    expect(matchLaneQuery(l, q('state:claimed area:protocol'))).toBe(true);
  });

  it('does not match an empty owner or role', () => {
    const l = lane({ owner_seat: null, role: null });
    expect(matchLaneQuery(l, q('owner:dreamy'))).toBe(false);
    expect(matchLaneQuery(l, q('role:platform'))).toBe(false);
  });
});

describe('matchGoalQuery', () => {
  it('matches bare words over the id, the title and the story', () => {
    const g = goal({ story: 'a plain-language line for outsiders' });
    expect(matchGoalQuery(g, q('find-work'))).toBe(true);
    expect(matchGoalQuery(g, q('board'))).toBe(true);
    expect(matchGoalQuery(g, q('outsiders'))).toBe(true);
    expect(matchGoalQuery(g, q('absent'))).toBe(false);
  });

  it('matches the derived status', () => {
    expect(matchGoalQuery(goal(), q('status:in-flight'))).toBe(true);
    expect(matchGoalQuery(goal(), q('status:shipped'))).toBe(false);
  });

  it('ORs repeats of one key', () => {
    expect(matchGoalQuery(goal(), q('status:shipped status:in-flight'))).toBe(true);
  });
});
