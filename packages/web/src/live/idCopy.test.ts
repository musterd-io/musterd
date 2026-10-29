import { describe, expect, it } from 'vitest';
import { copyPayload, copyShortcut, shownId } from './idCopy';

describe('work board IDs (lane 01M62KAMZ3)', () => {
  it('shows a lane by its ten-character short ULID and a goal by its slug', () => {
    expect(shownId('lane', '01M62KAMZ3K84CKXWZ3P94VEMK')).toBe('01M62KAMZ3');
    expect(shownId('goal', 'live-delight')).toBe('live-delight');
  });

  it('copies the bare ID, or the ID with its title', () => {
    expect(copyPayload('01M62KAMZ3', 'Work board IDs', false)).toBe('01M62KAMZ3');
    expect(copyPayload('01M62KAMZ3', 'Work board IDs', true)).toBe('01M62KAMZ3 — Work board IDs');
  });

  it('takes a bare c (⇧ for the title) and leaves ⌘C, Ctrl+C and typing alone', () => {
    const key = (k: Partial<KeyboardEvent> & { tag?: string }) =>
      copyShortcut({
        key: 'c',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...k,
        target: { tagName: k.tag ?? 'DIV', isContentEditable: false } as unknown as EventTarget,
      });
    expect(key({})).toEqual({ withTitle: false });
    expect(key({ key: 'C', shiftKey: true })).toEqual({ withTitle: true });
    expect(key({ metaKey: true })).toBeNull();
    expect(key({ ctrlKey: true })).toBeNull();
    expect(key({ tag: 'INPUT' })).toBeNull();
    expect(key({ tag: 'TEXTAREA' })).toBeNull();
    expect(key({ key: 'x' })).toBeNull();
  });
});
