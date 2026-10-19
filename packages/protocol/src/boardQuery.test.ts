import { describe, expect, it } from 'vitest';
import {
  BoardQuerySchema,
  emptyValuedKey,
  GOAL_QUERY_KEYS,
  LANE_QUERY_KEYS,
  parseBoardQuery,
  unknownQueryKey,
} from './boardQuery.js';

describe('parseBoardQuery', () => {
  it('reads bare words as words', () => {
    expect(parseBoardQuery('sync trace')).toEqual([
      { key: null, value: 'sync', phrase: false },
      { key: null, value: 'trace', phrase: false },
    ]);
  });

  it('reads key:value as a field', () => {
    expect(parseBoardQuery('goal:launch area:ui')).toEqual([
      { key: 'goal', value: 'launch', phrase: false },
      { key: 'area', value: 'ui', phrase: false },
    ]);
  });

  it('lowercases the key and keeps the value as typed', () => {
    expect(parseBoardQuery('STATE:Open')).toEqual([{ key: 'state', value: 'Open', phrase: false }]);
  });

  it('keeps a quoted phrase together and remembers it was a phrase', () => {
    expect(parseBoardQuery('"seat pulse" area:ui')).toEqual([
      { key: null, value: 'seat pulse', phrase: true },
      { key: 'area', value: 'ui', phrase: false },
    ]);
  });

  it('keeps a quoted value together', () => {
    expect(parseBoardQuery('role:"design lead"')).toEqual([
      { key: 'role', value: 'design lead', phrase: true },
    ]);
  });

  it('reads anything of the form word:… as a field, so an unknown key is a 400 and not a text search', () => {
    expect(parseBoardQuery('http://x/y')).toEqual([{ key: 'http', value: '//x/y', phrase: false }]);
    expect(unknownQueryKey(parseBoardQuery('http://x/y'), LANE_QUERY_KEYS)).toBe('http');
  });

  it('leaves a word without a colon a bare word', () => {
    expect(parseBoardQuery('packages/web/src')).toEqual([
      { key: null, value: 'packages/web/src', phrase: false },
    ]);
  });

  it('keeps a path value whole', () => {
    expect(parseBoardQuery('path:packages/web/src')).toEqual([
      { key: 'path', value: 'packages/web/src', phrase: false },
    ]);
  });

  it('splits on any whitespace', () => {
    expect(parseBoardQuery('a\tb\nc').map((t) => t.value)).toEqual(['a', 'b', 'c']);
  });

  it('keeps an empty value visible, so the caller can refuse it', () => {
    expect(emptyValuedKey(parseBoardQuery('goal:'))).toBe('goal');
    expect(emptyValuedKey(parseBoardQuery('goal:launch'))).toBeNull();
  });
});

describe('unknownQueryKey', () => {
  it('names the first key that is not allowed', () => {
    expect(unknownQueryKey(parseBoardQuery('area:ui nope:x'), LANE_QUERY_KEYS)).toBe('nope');
  });

  it('accepts every lane key', () => {
    const q = LANE_QUERY_KEYS.map((k) => `${k}:v`).join(' ');
    expect(unknownQueryKey(parseBoardQuery(q), LANE_QUERY_KEYS)).toBeNull();
  });

  it('accepts every goal key', () => {
    expect(unknownQueryKey(parseBoardQuery('status:shipped'), GOAL_QUERY_KEYS)).toBeNull();
    // A Goal has no surface: `area:` is a lane key, not a goal key.
    expect(unknownQueryKey(parseBoardQuery('area:ui'), GOAL_QUERY_KEYS)).toBe('area');
  });

  it('never calls a bare word an unknown key', () => {
    expect(unknownQueryKey(parseBoardQuery('sync'), LANE_QUERY_KEYS)).toBeNull();
  });
});

describe('BoardQuerySchema', () => {
  it('trims and bounds the argument', () => {
    expect(BoardQuerySchema.parse('  sync ')).toBe('sync');
    expect(BoardQuerySchema.safeParse('   ').success).toBe(false);
    expect(BoardQuerySchema.safeParse('x'.repeat(201)).success).toBe(false);
  });
});
