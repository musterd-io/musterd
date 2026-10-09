import { describe, expect, it } from 'vitest';
import {
  audienceFor,
  CAST,
  DEMO_ANCHOR,
  promptAct,
  promptBarFlag,
  promptBarVisible,
  REPLY_FOOTER,
} from './promptAct';

describe('promptAct — the envelope the bar sends', () => {
  it('opens a huddle on the cast, the shape `musterd huddle open --to a,b,c,d` sends', () => {
    const a = promptAct('  Give the members eyes.  ', CAST, '01ABC')!;
    expect(a.act).toBe('message');
    expect(a.to).toEqual({ kind: 'team' });
    expect(a.body).toBe(`Give the members eyes.\n\n${REPLY_FOOTER}`);
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

  // nick, 2026-10-09: a plain directed message to ghost sat in ghost's inbox — the wake rail only
  // starts a sleeping seat for interrupt-class acts, and a huddle is one. So one name is a one-seat
  // huddle, exactly what `musterd huddle open --to ghost` sends: it wakes them.
  it('with one member on, opens a huddle addressed to that seat — which wakes it', () => {
    const a = promptAct('hello', ['ghost'], 'x')!;
    expect(a.act).toBe('message');
    expect(a.to).toEqual({ kind: 'member', name: 'ghost' });
    expect(a.meta['huddle']).toBeDefined();
    expect(a.meta['eligible']).toBeUndefined();
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

describe('the reply footer (alfie, after the first rehearsal)', () => {
  it('is the fixed text, verbatim, after a blank line, on every huddle', () => {
    expect(REPLY_FOOTER).toBe(
      "Reply in this thread (team_send with thread = this act's id), not as a direct message. If you need nick, send an ask in this thread.",
    );
    expect(promptAct('hi', CAST, 'x')!.body.endsWith(`\n\n${REPLY_FOOTER}`)).toBe(true);
    expect(promptAct('hi', ['ghost'], 'x')!.body.endsWith(`\n\n${REPLY_FOOTER}`)).toBe(true);
  });
});

describe('audienceFor — the composer\'s @-picker (alfie, nick: "the future of musterd chat")', () => {
  it('nobody picked convenes the four-seat set, exactly as before', () => {
    expect(audienceFor([])).toEqual([...CAST]);
    const a = promptAct('hi', audienceFor([]), 'x')!;
    expect((a.meta as { eligible: string[] }).eligible).toEqual([...CAST]);
  });

  it('one picked is a huddle with that seat; two to four is a huddle on exactly those', () => {
    expect(promptAct('hi', audienceFor(['izzo']), 'x')!.to).toEqual({ kind: 'member', name: 'izzo' });
    const h = promptAct('hi', audienceFor(['izzo', 'dolly']), 'x')!;
    expect(h.to).toEqual({ kind: 'team' });
    expect((h.meta as { eligible: string[] }).eligible).toEqual(['izzo', 'dolly']);
    expect(audienceFor(['a', 'b', 'c', 'd', 'e'])).toHaveLength(4);
  });
});
