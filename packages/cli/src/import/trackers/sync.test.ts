import { describe, expect, it } from 'vitest';
import { absentRefs, planSync, type BoardLane } from './sync.js';
import type { TrackerIssue, TrackerSource } from './types.js';

const source: Pick<TrackerSource, 'tracker' | 'label' | 'scope' | 'ownsRef'> = {
  tracker: 'github',
  label: 'GitHub',
  scope: 'acme/app',
  ownsRef: (r) => /^acme\/app#\d+$/.test(r),
};
const issue = (n: number, title = `Issue ${String(n)}`): TrackerIssue => ({
  ref: `acme/app#${String(n)}`,
  title,
  url: `https://github.com/acme/app/issues/${String(n)}`,
});
let seq = 0;
const lane = (extra: Partial<BoardLane>): BoardLane => ({
  id: `L${String((seq += 1))}`,
  title: 'x',
  state: 'open',
  owner_seat: null,
  project: 'app',
  detail: null,
  ...extra,
});
const plan = (
  open: TrackerIssue[],
  lanes: BoardLane[],
  upstream: Record<string, 'closed' | 'not_found' | 'open'> = {},
) => planSync({ source, open, lanes, project: 'app', upstream, legacyGithub: true });
const codes = (p: ReturnType<typeof planSync>) => p.warnings.map((w) => w.code);

describe('planSync — the spec §3 table', () => {
  it('open, no lane → new', () => {
    const p = plan([issue(1)], []);
    expect(p.fresh.map((i) => i.ref)).toEqual(['acme/app#1']);
    expect(p.actions).toEqual([]);
  });

  it('open, lane with another title → rename only', () => {
    const l = lane({ title: 'Old', source_ref: 'acme/app#1' });
    const p = plan([issue(1, 'New')], [l]);
    expect(p.fresh).toEqual([]);
    expect(p.actions).toEqual([
      {
        kind: 'rename',
        lane_id: l.id,
        ref: 'acme/app#1',
        from: 'Old',
        title: 'New',
        held_by: null,
      },
    ]);
  });

  it('a rename records who held the lane at preview', () => {
    const l = lane({ title: 'Old', source_ref: 'acme/app#1', state: 'claimed', owner_seat: 'ada' });
    expect(plan([issue(1, 'New')], [l]).actions[0]).toMatchObject({
      kind: 'rename',
      held_by: 'ada',
    });
  });

  it('open, lane with the same title → unchanged, counted', () => {
    const p = plan([issue(1)], [lane({ title: 'Issue 1', source_ref: 'acme/app#1' })]);
    expect(p).toMatchObject({ fresh: [], actions: [], unchanged: 1, warnings: [] });
  });

  it('closed upstream, lane unclaimed → abandon with the reason', () => {
    const open = lane({ source_ref: 'acme/app#9' });
    const parked = lane({ source_ref: 'acme/app#8', state: 'parked' });
    const p = plan([], [open, parked], { 'acme/app#9': 'closed', 'acme/app#8': 'closed' });
    expect(p.actions).toEqual([
      {
        kind: 'abandon',
        lane_id: open.id,
        ref: 'acme/app#9',
        from: 'x',
        reason: 'closed in GitHub (acme/app#9)',
      },
      {
        kind: 'abandon',
        lane_id: parked.id,
        ref: 'acme/app#8',
        from: 'x',
        reason: 'closed in GitHub (acme/app#8)',
      },
    ]);
  });

  it('closed upstream, lane held → warning, untouched', () => {
    const claimed = lane({ source_ref: 'acme/app#9', state: 'claimed', owner_seat: 'ada' });
    const waiting = lane({
      source_ref: 'acme/app#8',
      state: 'awaiting_acceptance',
      owner_seat: null,
    });
    const p = plan([], [claimed, waiting], { 'acme/app#9': 'closed', 'acme/app#8': 'closed' });
    expect(p.actions).toEqual([]);
    expect(p.warnings.map((w) => w.message)).toEqual([
      `acme/app#9 closed upstream — lane ${claimed.id} held by ada, left alone`,
      `acme/app#8 closed upstream — lane ${waiting.id} held by awaiting_acceptance, left alone`,
    ]);
    expect(codes(p)).toEqual(['closed_held', 'closed_held']);
  });

  it('not found upstream → warning, untouched', () => {
    const l = lane({ source_ref: 'acme/app#9' });
    const p = plan([], [l], { 'acme/app#9': 'not_found' });
    expect(p.actions).toEqual([]);
    expect(p.warnings[0]).toMatchObject({
      level: 'warning',
      row: null,
      code: 'not_found',
      message: `acme/app#9 not found upstream (deleted, moved, or no access) — lane ${l.id} left alone`,
    });
  });

  it('reopened between the list and the check → unchanged', () => {
    const p = plan([], [lane({ source_ref: 'acme/app#9' })], { 'acme/app#9': 'open' });
    expect(p).toMatchObject({ actions: [], unchanged: 1, warnings: [] });
  });

  it('open, a legacy Source: line → adopt (and rename when the title moved)', () => {
    const same = lane({ title: 'Issue 1', detail: 'notes\n\nSource: acme/app#1' });
    const moved = lane({ title: 'Old', detail: 'Source: acme/app#2' });
    const p = plan([issue(1), issue(2, 'New')], [same, moved]);
    expect(p.fresh).toEqual([]);
    expect(p.actions).toEqual([
      { kind: 'adopt', lane_id: same.id, ref: 'acme/app#1' },
      { kind: 'adopt', lane_id: moved.id, ref: 'acme/app#2' },
      {
        kind: 'rename',
        lane_id: moved.id,
        ref: 'acme/app#2',
        from: 'Old',
        title: 'New',
        held_by: null,
      },
    ]);
  });
});

describe('planSync — around the table', () => {
  it('a legacy github#N is this repo’s only when the lane’s project is this project', () => {
    const mine = lane({ title: 'Issue 9', detail: 'Source: github#9', project: 'app' });
    const theirs = lane({ title: 'Issue 9', detail: 'Source: github#9', project: 'web' });
    const p = plan([issue(9)], [mine, theirs]);
    expect(p.actions).toEqual([{ kind: 'adopt', lane_id: mine.id, ref: 'acme/app#9' }]);
  });

  it('only a Source: line that ends the detail counts — phase 1 always wrote it last', () => {
    const quoted = lane({ detail: 'Someone pasted:\nSource: acme/app#9\nand kept writing' });
    const last = lane({ detail: 'Body\n\nSource: acme/app#8\n' });
    const p = plan([], [quoted, last], { 'acme/app#9': 'closed', 'acme/app#8': 'closed' });
    expect(p.actions.map((a) => [a.kind, a.lane_id])).toEqual([
      ['adopt', last.id],
      ['abandon', last.id],
    ]);
  });

  it('legacy github#N refs are read only when the imported repo is this workspace’s own', () => {
    const l = lane({ title: 'Old', detail: 'Source: github#9', project: 'app' });
    const p = planSync({
      source,
      open: [issue(9)],
      lanes: [l],
      project: 'app',
      upstream: { 'acme/app#9': 'closed' },
      legacyGithub: false,
    });
    expect(p.actions).toEqual([]);
    expect(p.fresh.map((i) => i.ref)).toEqual(['acme/app#9']);
    expect(absentRefs(source, [], [l], 'app', { legacyGithub: false })).toEqual([]);
  });

  it('a legacy closed lane is adopted before it is abandoned', () => {
    const l = lane({ detail: 'Source: github#9' });
    const p = plan([], [l], { 'acme/app#9': 'closed' });
    expect(p.actions.map((a) => a.kind)).toEqual(['adopt', 'abandon']);
  });

  it('a ref two live lanes hold → duplicate_ref, neither touched, not fresh', () => {
    const a = lane({ title: 'Old', source_ref: 'acme/app#1' });
    const b = lane({ title: 'Old', detail: 'Source: acme/app#1' });
    const p = plan([issue(1, 'New')], [a, b]);
    expect(p.fresh).toEqual([]);
    expect(p.actions).toEqual([]);
    expect(p.warnings[0]).toMatchObject({ code: 'duplicate_ref' });
    expect(p.warnings[0]!.message).toContain(`${a.id}, ${b.id}`);
  });

  it('ignores another repo’s refs, lanes with no ref, and closed lanes', () => {
    const p = plan(
      [issue(1)],
      [
        lane({ source_ref: 'other/app#1' }),
        lane({ title: 'no ref' }),
        lane({ source_ref: 'acme/app#1', state: 'done' }),
        lane({ source_ref: 'acme/app#7', state: 'abandoned' }),
      ],
    );
    expect(p.fresh.map((i) => i.ref)).toEqual(['acme/app#1']);
    expect(p.actions).toEqual([]);
    expect(p.warnings).toEqual([]);
  });

  it('an empty open set abandons nothing without a per-issue answer', () => {
    const p = plan([], [lane({ source_ref: 'acme/app#1' })], {});
    expect(p.actions).toEqual([]);
  });
});

describe('absentRefs', () => {
  it('returns the owned live refs missing from the open set, once each', () => {
    const lanes = [
      lane({ source_ref: 'acme/app#1' }),
      lane({ source_ref: 'acme/app#2' }),
      lane({ detail: 'Source: github#3' }),
      lane({ detail: 'Source: github#4', project: 'web' }),
      lane({ source_ref: 'other/app#5' }),
      lane({ source_ref: 'acme/app#6', state: 'done' }),
    ];
    expect(absentRefs(source, [issue(1)], lanes, 'app', { legacyGithub: true })).toEqual([
      'acme/app#2',
      'acme/app#3',
    ]);
  });
});
