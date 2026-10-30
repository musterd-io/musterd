import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearStaleIndexLock, STALE_INDEX_LOCK_MS } from './gitLock.js';

/**
 * 2026-10-30: an abandoned `index.lock` in the daemon checkout failed every refresh tick for about
 * 50 minutes. What matters: a lock past the age bound is removed and reported, a younger one is
 * left for the git command that may still hold it, and no lock is a no-op.
 */
describe('stale index.lock in the daemon checkout', () => {
  let gitDir: string;
  const lock = () => join(gitDir, 'index.lock');
  const writeLock = (mtimeMs: number) => {
    writeFileSync(lock(), '');
    utimesSync(lock(), mtimeMs / 1000, mtimeMs / 1000);
  };

  beforeEach(() => {
    gitDir = mkdtempSync(join(tmpdir(), 'musterd-gitlock-'));
  });
  afterEach(() => rmSync(gitDir, { recursive: true, force: true }));

  it('does nothing when there is no lock', () => {
    expect(clearStaleIndexLock(gitDir)).toEqual({ cleared: false, reason: 'none' });
  });

  it('leaves a lock younger than the bound, which a live git command may hold', () => {
    const now = Date.now();
    writeLock(now - STALE_INDEX_LOCK_MS + 60_000);
    expect(clearStaleIndexLock(gitDir, now)).toEqual({ cleared: false, reason: 'fresh' });
    expect(existsSync(lock())).toBe(true);
  });

  it('removes a lock past the bound and reports its age', () => {
    const now = Date.now();
    writeLock(now - 52 * 60_000);
    const result = clearStaleIndexLock(gitDir, now);
    expect(result.cleared).toBe(true);
    expect(result.cleared && result.ageMs).toBeGreaterThanOrEqual(52 * 60_000 - 1000);
    expect(existsSync(lock())).toBe(false);
  });
});
