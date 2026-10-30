import { describe, expect, it } from 'vitest';
import { alreadyAnswered, answerOf, triageKey } from './triage';

const base = { shift: false, inText: false, options: 3, picked: null as number | null, text: '' };

describe('triage keys (seats ask 1e)', () => {
  it('1–9 pick an option, a second press unpicks it, and a key past the options does nothing', () => {
    expect(triageKey('2', base)).toEqual({ kind: 'pick', choice: 1 });
    expect(triageKey('2', { ...base, picked: 1 })).toEqual({ kind: 'pick', choice: null });
    expect(triageKey('7', base)).toEqual({ kind: 'none' });
  });
  it('S skips and esc closes; typing in the box keeps S and digits as text', () => {
    expect(triageKey('s', base)).toEqual({ kind: 'skip' });
    expect(triageKey('Escape', { ...base, inText: true })).toEqual({ kind: 'close' });
    expect(triageKey('s', { ...base, inText: true })).toEqual({ kind: 'none' });
    expect(triageKey('1', { ...base, inText: true })).toEqual({ kind: 'none' });
  });
  it('↵ sends once there is something to send; ⇧↵ in the box is a newline', () => {
    expect(triageKey('Enter', base)).toEqual({ kind: 'none' });
    expect(triageKey('Enter', { ...base, picked: 1 })).toEqual({ kind: 'send' });
    expect(triageKey('Enter', { ...base, inText: true, text: 'x' })).toEqual({ kind: 'send' });
    expect(triageKey('Enter', { ...base, inText: true, shift: true, text: 'x' })).toEqual({ kind: 'none' });
  });
  it('option 2 plus typed text sends one answer carrying both', () => {
    expect(answerOf(1, '  then ping big-body ')).toEqual({ choice: 1, text: 'then ping big-body' });
    expect(answerOf(null, '')).toEqual({});
  });
  it("reads the daemon's already-answered refusal", () => {
    expect(alreadyAnswered('question_already_answered: answered by nick on app')).toEqual({ by: 'nick', channel: 'app' });
    expect(alreadyAnswered('boom')).toBeNull();
  });
});
