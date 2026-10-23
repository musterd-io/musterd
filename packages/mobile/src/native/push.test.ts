import { describe, expect, it } from 'vitest';
import { readFetchedBody, readPush } from './push';

const BLOCK = {
  v: 1,
  team: 'revive',
  binding: 'bind-1',
  ref: 'ask-9f3k',
  expires_at: 4_102_444_800_000,
  sealed: { v: 1, enc: 'AA', ct: 'BB' },
};

describe('readPush', () => {
  it('reads the musterd block off a push, and the block on its own', () => {
    expect(readPush({ aps: { alert: 'placeholder' }, musterd: BLOCK })).toEqual(BLOCK);
    expect(readPush(BLOCK)).toEqual(BLOCK);
  });

  it('allows a push with no sealed body, and refuses a malformed one', () => {
    const { sealed: _, ...route } = BLOCK;
    expect(readPush(route)).toEqual(route);
    expect(readPush({ ...BLOCK, sealed: { v: 1, enc: '', ct: 'BB' } })).toBeNull();
    expect(readPush({ ...BLOCK, v: 2 })).toBeNull();
    expect(readPush(null)).toBeNull();
  });

  it('reads a fetched body and ignores a missing seal', () => {
    const { v: _, ...fetched } = BLOCK;
    expect(readFetchedBody(fetched)).toEqual(fetched);
    expect(readFetchedBody({ team: 'revive', binding: 'b', ref: 'r', expires_at: 1 })).toBeNull();
  });
});
