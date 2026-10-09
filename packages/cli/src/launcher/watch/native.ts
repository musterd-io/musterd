import { join } from 'node:path';
import { BINDING_DIR } from '@musterd/protocol';
import { WAKE_WATCH_FILE } from '../../host/wakeWatchSpool.js';
import type { LocalWake } from '../live.js';
import { textEvent, toolEvent, type WatchEvent } from './events.js';
import { readCompleteLines } from './lines.js';
import type { WatchReader, WatchSnapshot } from './reader.js';

interface Line {
  lease_id?: unknown;
  t?: unknown;
  k?: unknown;
  s?: unknown;
  n?: unknown;
  a?: unknown;
  end?: unknown;
}

function parse(line: string): Line | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null ? (v as Line) : null;
  } catch {
    return null; // noise: skipped, never fatal
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * What a native wake said and did, from the spool the host writes beside the lease file
 * (`host/wakeWatchSpool.ts`): the first line must name THIS wake's lease, then one line per word or
 * tool call, then `end`. A spool that names another lease is a previous wake's, and reads as nothing.
 * Events still go through `textEvent` / `toolEvent`, so a spool line cannot slip past the watch rules.
 */
export function watchEvents(lines: readonly string[], leaseId: string): WatchSnapshot | null {
  const head = lines.length > 0 ? parse(lines[0]!) : null;
  if (head?.lease_id !== leaseId) return null;
  const events: WatchEvent[] = [];
  let end: unknown;
  for (const raw of lines.slice(1)) {
    const rec = parse(raw);
    if (!rec) continue;
    if (rec.end !== undefined) {
      end = rec.end;
      continue;
    }
    const ts = typeof rec.t === 'number' ? rec.t : null;
    if (rec.k === 'text') {
      const e = textEvent(ts, str(rec.s));
      if (e) events.push(e);
    } else if (rec.k === 'tool') {
      events.push(toolEvent(ts, str(rec.n) || 'tool', str(rec.a)));
    }
  }
  return { events, endedCleanly: end === 'clean' };
}

export interface NativeReaderDeps {
  readLines?: (path: string) => string[];
}

/** The native loop: no transcript file, so the host's spool for this lease (ADR 546, lane 6/6). */
export function nativeReader(deps: NativeReaderDeps = {}): WatchReader {
  return {
    snapshot(wake: LocalWake) {
      let lines: string[];
      try {
        lines = (deps.readLines ?? readCompleteLines)(
          join(wake.workspace, BINDING_DIR, WAKE_WATCH_FILE),
        );
      } catch {
        return null; // not written yet
      }
      return watchEvents(lines, wake.lease_id);
    },
  };
}
