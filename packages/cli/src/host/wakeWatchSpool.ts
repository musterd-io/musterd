import { closeSync, constants, lstatSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_DIR, scrubCredentials } from '@musterd/protocol';
import { pickArg } from '../launcher/watch/events.js';

/**
 * The native wake's watch spool (ADR 546, lane 6/6). Every other harness leaves a transcript file the
 * launcher can read; the native loop runs inside the host process and leaves none, so the host writes
 * the little `watch` needs beside the lease file: the loop's words and tool calls (never a tool's
 * result), one JSON line each, local only (ADR 131 §5), mode 0600.
 *
 * The first line names the lease it belongs to, so a spool left behind reads as nothing for the next
 * wake (which also replaces it). The last line (`end`) says how the run finished; the file is NOT
 * removed at settle, because the watcher's final read comes after the lease clears. Appends stop at
 * {@link SPOOL_MAX_BYTES}; the `end` line is still written, so a watcher is never left waiting.
 */
export const WAKE_WATCH_FILE = 'wake-watch.jsonl';
export const SPOOL_MAX_BYTES = 256 * 1024;
const FIELD_MAX = 500;

export type SpoolLine =
  | { lease_id: string }
  | { t: number; k: 'text'; s: string }
  | { t: number; k: 'tool'; n: string; a: string }
  | { end: 'clean' | 'early' };

export interface WakeWatchSpool {
  /** Record a completed turn's assistant content: text blocks and tool_use blocks, nothing else. */
  turn(assistantContent: unknown, at: number): void;
  /** The run is over. `clean` ⇒ it finished its work; anything else was cut short. */
  end(clean: boolean): void;
}

const clip = (s: string): string => scrubCredentials(s.slice(0, FIELD_MAX)).text;

/** Pure: the spool lines for one turn's assistant content blocks. */
export function spoolLinesFor(content: unknown, at: number): SpoolLine[] {
  if (!Array.isArray(content)) return [];
  const out: SpoolLine[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim()) {
      out.push({ t: at, k: 'text', s: clip(b['text']) });
    } else if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
      out.push({ t: at, k: 'tool', n: clip(b['name']), a: clip(pickArg(b['input'])) });
    }
  }
  return out;
}

/**
 * Open the spool for `leaseId`. Removed first and created exclusively with `O_NOFOLLOW`, and every
 * line goes through that one descriptor, so a symlink planted at the path — before the open or swapped
 * in after it — is never written through. A binding folder that is itself a symlink is refused.
 * Best-effort throughout: a folder the host cannot write
 * to costs the watch view, never the wake.
 */
export function openWakeWatchSpool(workspace: string, leaseId: string): WakeWatchSpool {
  const dir = join(workspace, BINDING_DIR);
  const path = join(dir, WAKE_WATCH_FILE);
  let bytes = 0;
  let fd: number | undefined;
  const put = (line: SpoolLine, force = false): void => {
    if (fd === undefined) return;
    const text = JSON.stringify(line) + '\n';
    if (!force && bytes + text.length > SPOOL_MAX_BYTES) return;
    try {
      writeSync(fd, text);
      bytes += text.length;
    } catch {
      close();
    }
  };
  const close = (): void => {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    fd = undefined;
  };
  try {
    mkdirSync(dir, { recursive: true });
    if (!lstatSync(dir).isDirectory()) throw new Error('binding folder is not a directory');
    rmSync(path, { force: true });
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    fd = undefined;
  }
  put({ lease_id: leaseId }, true);
  return {
    turn(content, at) {
      for (const l of spoolLinesFor(content, at)) put(l);
    },
    end(clean) {
      put({ end: clean ? 'clean' : 'early' }, true);
      close();
    },
  };
}
