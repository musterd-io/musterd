import { claudeReader } from './claude.js';
import { codexReader } from './codex.js';
import type { WatchReader } from './reader.js';

/**
 * The reader for a harness id (the lease file's `harness`), or undefined when watch does not know
 * that harness yet. Adding a harness is one reader file and one line here.
 */
export function watchReaderFor(harness: string): WatchReader | undefined {
  if (harness === 'claude-code') return claudeReader();
  if (harness === 'codex') return codexReader();
  return undefined;
}
