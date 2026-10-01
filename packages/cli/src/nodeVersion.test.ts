import { describe, expect, it } from 'vitest';
import { MIN_NODE_MAJOR, nodeVersionTooOld } from './nodeVersion.js';
import * as runtime from './runtime.js';

describe('nodeVersion (ADR 156, split for ADR 491)', () => {
  it('refuses Node below the floor and accepts the floor', () => {
    expect(MIN_NODE_MAJOR).toBe(22);
    expect(nodeVersionTooOld('v20.11.0')).toMatch(/needs Node >=22 \(you are on v20\.11\.0\)/);
    expect(nodeVersionTooOld('v22.0.0')).toBeNull();
    expect(nodeVersionTooOld('garbage')).toBeNull();
  });

  it('runtime.ts re-exports the same functions, so its callers are unchanged', () => {
    expect(runtime.nodeVersionTooOld).toBe(nodeVersionTooOld);
    expect(runtime.MIN_NODE_MAJOR).toBe(MIN_NODE_MAJOR);
  });
});
