import type { PickerRow, PickerView } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { pickAge, pickBlockedReason, pickItems, pickKey, pickNote, pickPatch, type PickState } from './pickList';

const row = (id: string, title: string, over: Partial<PickerRow> = {}): PickerRow => ({
  id,
  short: id.slice(0, 10),
  title,
  detail: null,
  goal_id: null,
  areas: [],
  risk: [],
  scope: [],
  age_ms: 0,
  blocked_on: [],
  declined: null,
  ...over,
});

const view: PickerView = {
  seat: 'izzo',
  claimable: [
    { goal: 'cloud', rows: [row('01AAAAAAAAAA', 'dup envelope id → 409', { goal_id: 'cloud' })] },
    { goal: null, rows: [row('01BBBBBBBBBB', 'console /health build'), row('01CCCCCCCCCC', 'stream stall')] },
  ],
  blocked: [
    {
      goal: 'launch',
      rows: [
        row('01DDDDDDDDDD', 'smooth capture inc 4', {
          goal_id: 'launch',
          blocked_on: [{ lane: '01EEEEEEEEEE', owner: 'slippy', detail: 'still claimed' }],
        }),
      ],
    },
  ],
  carrying: [],
};

const start: PickState = { tab: 'claimable', filter: '', cursor: 0 };

describe('the /live lane picker (lane 01M5162T6H, spec §5.4)', () => {
  it('lists the tab’s rows in board order, flattened across goals', () => {
    expect(pickItems(view, start).map((r) => r.short)).toEqual(['01AAAAAAAA', '01BBBBBBBB', '01CCCCCCCC']);
    expect(pickItems(view, { ...start, tab: 'blocked' }).map((r) => r.short)).toEqual(['01DDDDDDDD']);
  });

  it('filters with the same words-must-all-match rule the terminal uses', () => {
    expect(pickItems(view, { ...start, filter: 'stream' }).map((r) => r.title)).toEqual(['stream stall']);
    expect(pickItems(view, { ...start, filter: 'cloud 409' }).map((r) => r.title)).toEqual(['dup envelope id → 409']);
  });

  it('moves with ↑/↓, clamps at the ends, and jumps with Home/End', () => {
    const n = 3;
    expect(pickKey(start, 'ArrowDown', n).cursor).toBe(1);
    expect(pickKey({ ...start, cursor: 2 }, 'ArrowDown', n).cursor).toBe(2);
    expect(pickKey(start, 'ArrowUp', n).cursor).toBe(0);
    expect(pickKey(start, 'End', n).cursor).toBe(2);
    expect(pickKey({ ...start, cursor: 2 }, 'Home', n).cursor).toBe(0);
  });

  it('Tab switches between claimable and blocked and starts at the top', () => {
    const s = pickKey({ ...start, cursor: 2 }, 'Tab', 3);
    expect(s).toEqual({ ...start, tab: 'blocked', cursor: 0 });
    expect(pickKey(s, 'Tab', 1).tab).toBe('claimable');
  });

  it('a new filter puts the cursor back on the first match', () => {
    expect(pickKey({ ...start, cursor: 2 }, { filter: 'cl' }, 3)).toEqual({ ...start, filter: 'cl', cursor: 0 });
  });

  it('a pick is the existing handoff from the human, with a note that says so (spec §5.5)', () => {
    expect(pickPatch(view.claimable[1]!.rows[0]!, 'izzo', 'nick')).toEqual({
      owner_seat: 'izzo',
      handoff_note: pickNote('nick'),
    });
    expect(pickNote('nick')).toBe(
      'nick picked this lane for you in the lane picker (/live, signed in). Reply with a 3–5 line plan, then start unless redirected.',
    );
  });

  it('never picks a blocked lane: there is no patch, only the reason', () => {
    expect(pickPatch(view.blocked[0]!.rows[0]!, 'izzo', 'nick')).toBeNull();
  });

  it('says a lane’s age the way the list does', () => {
    expect(pickAge(30_000)).toBe('just now');
    expect(pickAge(12 * 60_000)).toBe('12m');
    expect(pickAge(5 * 3_600_000)).toBe('5h');
    expect(pickAge(3 * 86_400_000 + 5)).toBe('3d');
  });

  it('names what a blocked lane waits on and who holds it', () => {
    expect(pickBlockedReason(view.blocked[0]!.rows[0]!)).toBe('01EEEEEEEE (slippy)');
  });
});
