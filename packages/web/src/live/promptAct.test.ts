import { describe, expect, it } from 'vitest';
import { CAST, DEMO_ANCHOR, promptAct, promptBarFlag, promptBarVisible } from './promptAct';

describe('promptAct — the envelope the bar sends', () => {
  it('opens a huddle on the cast, the shape `musterd huddle open --to a,b,c,d` sends', () => {
    const a = promptAct('  Give the members eyes.  ', CAST, '01ABC')!;
    expect(a.act).toBe('message');
    expect(a.to).toEqual({ kind: 'team' });
    expect(a.body).toBe('Give the members eyes.');
    expect(a.meta).toEqual({
      huddle: {
        topic: { kind: 'design', id: 'demo' },
        room: 'http://127.0.0.1:4851/b/huddle-01abc',
        anchor: DEMO_ANCHOR,
        budget: { turns: 40 },
      },
      eligible: ['dolly', 'big-body', 'ghost', 'wanderer'],
    });
  });

  it('with one member on, sends a plain directed message to that seat', () => {
    expect(promptAct('hello', ['ghost'], 'x')).toEqual({
      act: 'message',
      to: { kind: 'member', name: 'ghost' },
      body: 'hello',
      meta: {},
    });
  });

  it('sends nothing for empty text or nobody on, and never more than four', () => {
    expect(promptAct('   ', CAST, 'x')).toBeNull();
    expect(promptAct('hi', [], 'x')).toBeNull();
    const five = promptAct('hi', [...CAST, 'extra'], 'x')!;
    expect((five.meta as { eligible: string[] }).eligible).toHaveLength(4);
  });
});

describe('the gates', () => {
  it('reads the flag from ?promptbar=1, ?promptbar or #promptbar, and nothing else', () => {
    expect(promptBarFlag('?promptbar=1', '')).toBe(true);
    expect(promptBarFlag('?team=revive&promptbar', '')).toBe(true);
    expect(promptBarFlag('', '#promptbar')).toBe(true);
    expect(promptBarFlag('?team=revive', '')).toBe(false);
    expect(promptBarFlag('?promptbar=0', '')).toBe(false);
  });

  it('shows the bar only when the flag, a signed-in member and an admin all hold', () => {
    expect(promptBarVisible({ flag: true, signedIn: true, admin: true })).toBe(true);
    expect(promptBarVisible({ flag: false, signedIn: true, admin: true })).toBe(false);
    expect(promptBarVisible({ flag: true, signedIn: false, admin: true })).toBe(false); // the observer
    expect(promptBarVisible({ flag: true, signedIn: true, admin: false })).toBe(false);
  });
});
