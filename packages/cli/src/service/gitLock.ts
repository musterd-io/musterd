import { statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An abandoned `index.lock` in the daemon's checkout, cleared before `service refresh` syncs.
 *
 * git takes `.git/index.lock` for the few seconds a `switch` or `checkout` runs and removes it when
 * the command ends. A git process that dies part way leaves the file behind, and every later git
 * write in that checkout then fails with `Unable to create '…/index.lock': File exists`. Measured
 * 2026-10-30 on the dogfood machine: an empty lock dated 13:53 made every auto-refresh tick fail at
 * `git switch origin/main` for about 50 minutes. The daemon stayed on an old build, and merges
 * (ADR 775 among them) did not deploy until a seat removed the file by hand.
 *
 * **Age is the test.** A lock older than {@link STALE_INDEX_LOCK_MS} is not held by a live git
 * command in this checkout. The refresh is the only writer there and it runs one git command at a
 * time, so a ten-minute-old lock has no owner. A younger lock is left alone: the tick fails as it
 * did before and the next tick looks again.
 */

/** How old an `index.lock` must be before the refresh treats it as abandoned. */
export const STALE_INDEX_LOCK_MS = 10 * 60 * 1000;

export type IndexLockResult =
  | { cleared: false; reason: 'none' | 'fresh' }
  | { cleared: true; ageMs: number };

/** Remove `<gitDir>/index.lock` when it is older than `maxAgeMs`; report what was found. */
export function clearStaleIndexLock(
  gitDir: string,
  now: number = Date.now(),
  maxAgeMs: number = STALE_INDEX_LOCK_MS,
): IndexLockResult {
  const lock = join(gitDir, 'index.lock');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lock).mtimeMs;
  } catch {
    return { cleared: false, reason: 'none' };
  }
  const ageMs = now - mtimeMs;
  if (ageMs < maxAgeMs) return { cleared: false, reason: 'fresh' };
  unlinkSync(lock);
  return { cleared: true, ageMs };
}
