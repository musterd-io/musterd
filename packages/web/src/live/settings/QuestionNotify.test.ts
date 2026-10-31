import { describe, expect, it } from 'vitest';
import { withChange } from './QuestionNotify';

describe('question notification prefs (seats ask 2f)', () => {
  it('sets a channel loudness without touching the rest', () => {
    expect(withChange({ seats: { ryder: 'never' } }, { channel: 'slack', level: 'quiet' })).toEqual({
      seats: { ryder: 'never' },
      channels: { slack: 'quiet' },
    });
  });
  it('sets a seat to always or never, and Default clears it back to the default', () => {
    const p = withChange({}, { seat: 'ryder', level: 'never' });
    expect(p.seats).toEqual({ ryder: 'never' });
    expect(withChange(p, { seat: 'ryder', level: '' }).seats).toEqual({});
  });
});
